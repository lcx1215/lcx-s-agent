import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundPerception,
  runCentralHarnessCycle,
  nextCycleContinuation,
  compactReceipts,
  markCentralArtifactOutcome,
} from "./harness-loop.js";
import type { CentralPerception, CentralToolSpec, CentralRunReceipt } from "./types.js";

const perception: CentralPerception = {
  observedAt: "2026-09-21T00:00:00Z",
  ownerTotals: {},
  controlRoom: {},
  backlog: [],
  boundaries: [],
};
const brain = {
  propose: async () => ({
    kind: "proposed" as const,
    provider: "fixture",
    modelId: "fixture",
    plan: {
      actions: [
        { ownerId: "fixture", args: { page: 1 } },
        { ownerId: "fixture", args: { page: 2 } },
      ],
      note: "fixture",
    },
  }),
};
function registry(execute: CentralToolSpec["execute"]) {
  return new Map<string, CentralToolSpec>([
    [
      "fixture",
      {
        ownerId: "fixture",
        name: "fixture",
        label: "fixture",
        description: "fixture",
        allowedSideEffects: [],
        boundary: [],
        approve: () => ({ ok: true }),
        execute,
      },
    ],
  ]);
}
afterEach(() => vi.useRealTimers());

it.each(["count", "bytes"] as const)(
  "keeps the latest host-bound result beside older verified selections under %s pressure",
  async (pressure) => {
    const base = await runCentralHarnessCycle({
      perception,
      brain,
      registry: registry(async () => ({ observedOk: true, value: 1 })),
    });
    const selected: CentralRunReceipt[] = Array.from({ length: 8 }, (_, index) => ({
      ...base,
      runId: `old-selection-${index}`,
      observedAt: new Date(Date.parse(perception.observedAt) + index * 1000).toISOString(),
      steps: [
        {
          ...base.steps[0],
          ownerId: "artifact_memory_recall",
          args: { action: "read", id: `artifact-${"a".repeat(64)}`, field: `/value/rows/${index}` },
          outcome: {
            available: true,
            action: "read",
            artifactId: `artifact-${"a".repeat(64)}`,
            field: `/value/rows/${index}`,
            sourceSha256: "b".repeat(64),
            selectedValue: { index, data: "x".repeat(pressure === "bytes" ? 700 : 20) },
          },
        },
      ],
    }));
    const resultArtifact = {
      status: "registered" as const,
      reason: "ok",
      id: `artifact-${"c".repeat(64)}`,
      sha256: "d".repeat(64),
    };
    const latest: CentralRunReceipt = {
      ...base,
      runId: "latest-result",
      observedAt: new Date(Date.parse(perception.observedAt) + 10000).toISOString(),
      steps: [
        {
          ...base.steps[0],
          ownerId: "finance_strategy_rule_ledger_read",
          args: { includeBodies: true },
          resultArtifact,
          outcome: {
            status: "ready",
            ruleCount: 4,
            activeRuleCount: 2,
            ruleSummary: "Newest rule body result.",
          },
        },
      ],
    };
    const noop: CentralRunReceipt = {
      ...base,
      runId: "later-noop",
      observedAt: new Date(Date.parse(perception.observedAt) + 11000).toISOString(),
      steps: [],
    };
    const backlog = compactReceipts([...selected, latest, noop], pressure === "count" ? 3 : 10);
    const fresh = backlog
      .flatMap((entry) => entry.outcomes)
      .find((entry) => entry.resultArtifact?.id === resultArtifact.id);
    expect(fresh).toMatchObject({
      sourceObservedAt: latest.observedAt,
      args: latest.steps[0].args,
      resultArtifact,
      outcome: latest.steps[0].outcome,
    });
    expect(
      backlog.some((entry) =>
        entry.outcomes.some(
          (outcome) =>
            outcome.ownerId === "artifact_memory_recall" && outcome.outcome?.selectedValue,
        ),
      ),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(backlog))).toBeLessThanOrEqual(8500);
    expect(backlog[0].backlogEntriesOmitted).toBeGreaterThan(0);
    expect(boundPerception({ ...perception, backlog }).report.overBudget).toBe(false);
  },
);

it("marks an explicit tool rejection red while preserving bounded self-recovery", async () => {
  const spec: CentralToolSpec = {
    ownerId: "finance_position_ledger_read",
    name: "fixture",
    label: "fixture",
    description: "fixture",
    boundary: [],
    allowedSideEffects: [],
    approve: () => ({ ok: true }),
    execute: async () => ({
      ok: false,
      status: "unsupported_scope",
      reason: "broker_history_as_of_filter_not_supported",
    }),
  };
  const receipt = await runCentralHarnessCycle({
    perception,
    registry: new Map([[spec.ownerId, spec]]),
    brain: {
      propose: async () => ({
        kind: "proposed",
        provider: "fixture",
        modelId: "fixture",
        plan: {
          actions: [
            {
              ownerId: spec.ownerId,
              args: { brokerAccountId: "fixture", asOf: perception.observedAt },
            },
          ],
          note: "read native protection",
        },
      }),
    },
  });
  expect(receipt.steps[0]).toMatchObject({
    status: "ran_ok",
    observedOk: false,
    outcome: { ok: false },
  });
  expect(receipt.nextAction).toBe("follow_up_on_owners_reporting_not_ok");
  expect(compactReceipts([receipt], 10)[0].notOk).toEqual([spec.ownerId]);
  expect(nextCycleContinuation(receipt, 1, 2)).toMatchObject({ run: true });
});

it.each([null, -12.5])(
  "carries account-scoped economics and cost gaps into the next decision (pnl=%s)",
  async (pnl) => {
    const brokerSnapshot = {
      status: "present",
      accounts: [
        {
          accountId: "fixture-paper-account",
          snapshotRef: "b".repeat(64),
          observedAt: perception.observedAt,
          freshness: "fresh",
          holdings: [{ instrument: "TLT", positionQuantity: 130, status: "no_recognized_stop" }],
          omittedHoldings: 15,
        },
      ],
    };
    const economics = {
      accountId: "fixture-paper-account",
      venue: "alpaca:paper",
      baselineSource: "sealed_broker_history",
      diagnostic: {
        status: pnl === null ? "incomplete_cost_coverage" : "realized_trade_pnl_after_fees",
        pnlBasis: "broker_fills_after_supported_fees_only",
        historyStatus: "reconciled",
        feeCoverageComplete: pnl !== null,
        realizedTradePnlAfterFees: pnl,
        netProfitability: "not_proven",
        executionThresholdPromotionEligible: false,
        blockers: [
          "this projection does not include current open-position marks or full account equity",
          "dividends, other corporate actions, borrow, financing, and an aligned benchmark are not included",
        ],
      },
    };
    const spec: CentralToolSpec = {
      ownerId: "finance_position_ledger_read",
      name: "finance_position_ledger_read",
      label: "fixture",
      description: "fixture",
      boundary: [],
      allowedSideEffects: [],
      approve: () => ({ ok: true }),
      execute: async () => ({
        schemaVersion: "lcx_finance_position_ledger_read_v2",
        status: "ready",
        ledgerDirectory: "fixture://host-owned-ledger",
        databasePath: "fixture://host-owned-database",
        positions: Array.from({ length: 100 }, () => ({ instrument: "FIXTURE", quantity: 1 })),
        headRef: "a".repeat(64),
        brokerTradeEconomics: economics,
        brokerSnapshot,
      }),
    };
    const options = {
      perception,
      registry: new Map([[spec.ownerId, spec]]),
      brain: {
        propose: async () => ({
          kind: "proposed" as const,
          provider: "fixture",
          modelId: "fixture",
          plan: {
            actions: [{ ownerId: spec.ownerId, args: { brokerAccountId: economics.accountId } }],
            note: "read recorded account economics",
          },
        }),
      },
    };
    const first = await runCentralHarnessCycle(options);
    expect(first.steps[0].outcome?.brokerTradeEconomics).toEqual(economics);
    expect(first.steps[0].outcome?.brokerSnapshot).toEqual(brokerSnapshot);
    expect(first.steps[0].outcomeDroppedKeys).toContain("positions");
    expect(Buffer.byteLength(JSON.stringify(first.steps[0].outcome))).toBeLessThanOrEqual(4096);
    const backlog = compactReceipts([first], 10);
    expect(backlog[0].outcomes[0].outcome?.brokerTradeEconomics).toEqual(economics);
    expect(backlog[0].outcomes[0].outcome?.brokerSnapshot).toEqual(brokerSnapshot);
    expect(backlog[0].outcomes[0].args).toEqual({ brokerAccountId: economics.accountId });
    expect(boundPerception({ ...perception, backlog }).report.overBudget).toBe(false);
    const next = await runCentralHarnessCycle({
      ...options,
      perception: { ...perception, backlog },
      brain: {
        propose: async (seen: CentralPerception) => {
          expect(seen.backlog).toEqual(backlog);
          return {
            kind: "proposed",
            provider: "fixture",
            modelId: "fixture",
            plan: { actions: [], note: "cost and account-return limits remain unresolved" },
          };
        },
      },
    });
    expect(next.steps).toHaveLength(0);
  },
);

it("names oversized bar-source comparisons instead of exceeding the existing read-page budget", async () => {
  const sourceSelection = {
    allSourcesDivergentDates: Array.from({ length: 500 }, (_, i) => `WBD@${i}`),
  };
  const spec: CentralToolSpec = {
    ownerId: "finance_bar_ledger",
    name: "finance_bar_ledger",
    label: "fixture",
    description: "fixture",
    boundary: [],
    allowedSideEffects: [],
    approve: () => ({ ok: true }),
    execute: async () => ({
      schemaVersion: "lcx_finance_bar_ledger_tool_v1",
      status: "ready",
      sourceSelection,
      divergentDates: [],
      headRef: "a".repeat(64),
      bars: [{ instrument: "WBD", date: "2026-09-01", close: 30 }],
    }),
  };
  const receipt = await runCentralHarnessCycle({
    perception,
    registry: new Map([[spec.ownerId, spec]]),
    brain: {
      propose: async () => ({
        kind: "proposed",
        provider: "fixture",
        modelId: "fixture",
        plan: { actions: [{ ownerId: spec.ownerId, args: { action: "read" } }], note: "fixture" },
      }),
    },
  });
  expect(receipt.steps[0].outcome).not.toHaveProperty("sourceSelection");
  expect(receipt.steps[0].outcomeDroppedKeys).toContain("sourceSelection");
  expect(Buffer.byteLength(JSON.stringify(receipt.steps[0].outcome))).toBeLessThanOrEqual(4096);
  const backlog = compactReceipts([receipt], 10);
  expect(backlog[0].outcomes[0].outcomeDroppedKeys).toContain("sourceSelection");
  const bounded = boundPerception({ ...perception, backlog });
  expect(bounded.report.overBudget).toBe(false);
  expect(bounded.report.injectedBytes).toBeLessThanOrEqual(12000);
});

it("carries a snapshot-only holdings cursor through backlog into the next decision", async () => {
  const nextCursor = "cursor-".repeat(60);
  const brokerSnapshot = {
    status: "present",
    accounts: [
      {
        accountId: "fixture",
        snapshotRef: "a".repeat(64),
        observedAt: perception.observedAt,
        holdings: Array.from({ length: 4 }, (_, index) => ({
          instrument: `FIX${index}`,
          sourceNote: "retained-".repeat(30),
        })),
        holdingsPage: { nextCursor, complete: false },
      },
    ],
  };
  const spec: CentralToolSpec = {
    ownerId: "finance_position_ledger_read",
    name: "fixture",
    label: "fixture",
    description: "fixture",
    boundary: [],
    allowedSideEffects: [],
    approve: () => ({ ok: true }),
    execute: async () => ({
      schemaVersion: "lcx_finance_position_ledger_read_v2",
      status: "present",
      brokerSnapshotOnly: true,
      brokerSnapshot,
    }),
  };
  const receipt = await runCentralHarnessCycle({
    perception,
    registry: new Map([[spec.ownerId, spec]]),
    brain: {
      propose: async () => ({
        kind: "proposed",
        provider: "fixture",
        modelId: "fixture",
        plan: {
          actions: [
            {
              ownerId: spec.ownerId,
              args: { brokerAccountId: "fixture", brokerSnapshotOnly: true },
            },
          ],
          note: "read missing holdings",
        },
      }),
    },
  });
  const backlog = compactReceipts([receipt], 10);
  expect(backlog[0].outcomes[0].outcome?.brokerSnapshot).toEqual(brokerSnapshot);
  const next = await runCentralHarnessCycle({
    perception: { ...perception, backlog },
    registry: new Map([[spec.ownerId, spec]]),
    brain: {
      propose: async (seen: CentralPerception) => {
        expect(seen.backlog[0]).toHaveProperty("outcomes.0.outcome.brokerSnapshot", brokerSnapshot);
        return {
          kind: "proposed",
          provider: "fixture",
          modelId: "fixture",
          plan: { actions: [], note: "continue exact retained page cursor" },
        };
      },
    },
  });
  expect(next.steps).toEqual([]);
});

it("retains native protection when the same read also requests historical orders", async () => {
  const brokerSnapshot = {
    status: "present",
    accounts: [
      {
        observedAt: perception.observedAt,
        freshness: "stale",
        snapshotRef: "a".repeat(64),
        holdings: [{ instrument: "TLT", positionQuantity: 130, status: "no_recognized_stop" }],
      },
    ],
  };
  const spec: CentralToolSpec = {
    ownerId: "finance_position_ledger_read",
    name: "fixture",
    label: "fixture",
    description: "fixture",
    boundary: [],
    allowedSideEffects: [],
    approve: () => ({ ok: true }),
    execute: async () => ({
      schemaVersion: "lcx_finance_position_ledger_read_v2",
      status: "ready",
      brokerSnapshot,
      historyKind: "order",
      history: { items: [{ orderId: "old-canceled" }] },
      positions: Array.from({ length: 100 }, () => ({ instrument: "FIXTURE", quantity: 1 })),
    }),
  };
  const receipt = await runCentralHarnessCycle({
    perception,
    registry: new Map([[spec.ownerId, spec]]),
    brain: {
      propose: async () => ({
        kind: "proposed",
        provider: "fixture",
        modelId: "fixture",
        plan: {
          note: "read native protection and historical orders without conflating them",
          actions: [
            { ownerId: spec.ownerId, args: { brokerAccountId: "fixture", historyKind: "order" } },
          ],
        },
      }),
    },
  });
  expect(receipt.steps[0].outcome?.brokerSnapshot).toEqual(brokerSnapshot);
  expect(receipt.steps[0].outcome?.history).toEqual({ items: [{ orderId: "old-canceled" }] });
  expect(compactReceipts([receipt], 10)[0].outcomes[0].outcome?.brokerSnapshot).toEqual(
    brokerSnapshot,
  );
});

describe("executed governance result feedback", () => {
  it.each([true, false])(
    "consumes a successful owner result before deciding the next action (ready=%s)",
    async (ready) => {
      const receipts: CentralRunReceipt[] = [];
      const execute = vi.fn(async () => ({
        observedOk: true,
        receipt: {
          ok: true,
          readiness: ready ? "ready" : "needs_evidence",
          source: "owner-result",
        },
      }));
      const decide = vi.fn(async (seen: CentralPerception) => {
        const result = compactReceipts(receipts, 10)
          .flatMap((entry) => entry.outcomes)
          .find((entry) => entry.ownerId === "fixture")?.outcome;
        expect(seen.backlog).toEqual(compactReceipts(receipts, 10));
        return {
          kind: "proposed" as const,
          provider: "offline-fixture",
          modelId: "scripted-owner-consumer",
          plan: {
            actions: result ? [] : [{ ownerId: "fixture" }],
            note: result
              ? result.readiness === "ready"
                ? "ready_from_owner_evidence"
                : "stop_with_missing_evidence"
              : "read_owner",
          },
        };
      });
      for (let cycle = 1; cycle <= 3; cycle++) {
        const receipt = await runCentralHarnessCycle({
          perception: { ...perception, backlog: compactReceipts(receipts, 10) },
          registry: registry(execute),
          brain: { propose: decide },
          planOnly: false,
          capabilityOwnerIds: new Set(),
        });
        receipts.push(receipt);
        if (!nextCycleContinuation(receipt, cycle, 3, receipts.at(-2)).run) {
          break;
        }
      }
      expect(execute).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledTimes(2);
      expect(receipts[0].nextAction).toBe("follow_up_on_owner_results");
      expect(compactReceipts(receipts, 10)[0].outcomes[0]).toMatchObject({
        ownerId: "fixture",
        sourceObservedAt: perception.observedAt,
        outcome: { source: "owner-result", readiness: ready ? "ready" : "needs_evidence" },
      });
      expect(receipts[1].brainCall.note).toBe(
        ready ? "ready_from_owner_evidence" : "stop_with_missing_evidence",
      );
      expect(receipts[1].actionsProposed).toBe(0);
      expect(receipts.every((receipt) => !receipt.providerConfigTouched)).toBe(true);
    },
  );

  it("carries only a host-bound owner archive reference and preserves receipt fields", async () => {
    const ownerFields = { artifactEvidence: { id: "source-owned" }, readiness: "review" };
    const hostReference = {
      status: "registered",
      reason: "ok",
      id: `artifact-${"a".repeat(64)}`,
      sha256: "b".repeat(64),
    };
    const execute = async () =>
      markCentralArtifactOutcome(
        { observedOk: true, receipt: ownerFields, artifactEvidence: hostReference },
        { observedOk: true, receipt: ownerFields },
      );
    const result = await runCentralHarnessCycle({ perception, brain, registry: registry(execute) });
    const carried = compactReceipts([result], 10)[0].outcomes[0];
    expect(carried.resultArtifact).toEqual(hostReference);
    expect(carried.outcome?.artifactEvidence).toEqual(ownerFields.artifactEvidence);
    const unbound = await runCentralHarnessCycle({
      perception,
      brain,
      registry: registry(async () => ({
        observedOk: true,
        receipt: ownerFields,
        artifactEvidence: hostReference,
      })),
    });
    expect(unbound.steps[0].resultArtifact).toBeUndefined();
  });

  it("does not create a follow-up from metadata-only green receipts", async () => {
    const result = await runCentralHarnessCycle({
      perception,
      brain,
      registry: registry(async () => ({
        observedOk: true,
        receipt: { ok: true, checkedAt: perception.observedAt, output: '{"ok":true}' },
      })),
    });
    expect(result.nextAction).toBe("continue");
    expect(compactReceipts([result], 10)[0].outcomes).toEqual([]);
  });

  it("stops an unchanged successful owner result and respects the cycle limit", async () => {
    const options = {
      perception,
      registry: registry(async () => ({ observedOk: true, receipt: { ok: true, value: 7 } })),
      brain,
    };
    const first = await runCentralHarnessCycle(options);
    const same = await runCentralHarnessCycle(options);
    expect(nextCycleContinuation(first, 1, 3)).toEqual({ run: true, because: "owner_results" });
    expect(nextCycleContinuation(same, 2, 3, first)).toEqual({
      run: false,
      because: "unchanged_result",
    });
    expect(nextCycleContinuation(first, 1, 1)).toEqual({
      run: false,
      because: "max_cycles_reached",
    });
  });

  it("does not follow up an unexecuted plan or a success without a result", async () => {
    const execute = vi.fn(async () => ({ observedOk: true }));
    const planned = await runCentralHarnessCycle({
      perception,
      registry: registry(execute),
      brain,
      planOnly: true,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(planned.nextAction).toBe("continue");
    expect(compactReceipts([planned], 10)[0].outcomes).toEqual([]);
    const noResult = await runCentralHarnessCycle({
      perception,
      registry: registry(async () => ({})),
      brain,
    });
    expect(noResult.nextAction).toBe("continue");
  });
});

describe("central cycle cancellation and failure closure", () => {
  it("does not dispatch the brain after wall-clock expiry before timers run", async () => {
    vi.useFakeTimers();
    const deadlineMs = Date.now() + 10;
    const propose = vi.fn(brain.propose);
    const pending = runCentralHarnessCycle({
      perception,
      registry: registry(async () => ({})),
      brain: { propose },
      deadlineMs,
    });
    vi.setSystemTime(deadlineMs + 1);
    const receipt = await pending;
    expect(propose).not.toHaveBeenCalled();
    expect(receipt.brainCall.outcome).toBe("failed");
    expect(receipt.nextAction).toBe("halt_and_report");
  });

  it("rejects a brain proposal returned after wall-clock expiry without dispatching owners", async () => {
    vi.useFakeTimers();
    const deadlineMs = Date.now() + 10;
    const execute = vi.fn(async () => ({ observedOk: true }));
    const receipt = await runCentralHarnessCycle({
      perception,
      registry: registry(execute),
      brain: {
        propose: async () => {
          vi.setSystemTime(deadlineMs + 1);
          return brain.propose();
        },
      },
      deadlineMs,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(receipt.brainCall.outcome).toBe("failed");
    expect(receipt.brainCall.reason).toContain("central cycle deadline exceeded");
    expect(receipt.nextAction).toBe("halt_and_report");
  });

  it("rechecks wall-clock expiry after the gate before dispatching an owner", async () => {
    vi.useFakeTimers();
    const deadlineMs = Date.now() + 10;
    const execute = vi.fn(async () => ({ observedOk: true }));
    const tools = registry(execute);
    const fixture = tools.get("fixture")!;
    tools.set("fixture", {
      ...fixture,
      approve: () => {
        vi.setSystemTime(deadlineMs + 1);
        return { ok: true };
      },
    });
    const receipt = await runCentralHarnessCycle({
      perception,
      brain,
      registry: tools,
      deadlineMs,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(receipt.steps.every((step) => step.status === "ran_failed")).toBe(true);
    expect(receipt.nextAction).toBe("halt_and_report");
  });

  it("rejects late owner success and stops subsequent dispatch before timers run", async () => {
    vi.useFakeTimers();
    const deadlineMs = Date.now() + 10;
    const execute = vi.fn(async () => {
      vi.setSystemTime(deadlineMs + 1);
      return { observedOk: true, receipt: { value: "late" } };
    });
    const receipt = await runCentralHarnessCycle({
      perception,
      brain,
      registry: registry(execute),
      deadlineMs,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipt.steps.map((step) => step.status)).toEqual(["ran_failed", "ran_failed"]);
    expect(receipt.steps[0].failureReason).toContain("central cycle deadline exceeded");
    expect(receipt.steps[0].outcome).toBeUndefined();
    expect(receipt.nextAction).toBe("halt_and_report");
  });

  it("settles a terminal receipt when a brain ignores the deadline signal", async () => {
    vi.useFakeTimers();
    const settle = vi.fn(async () => ({
      runId: "test",
      observedAt: perception.observedAt,
      approved: [],
      blocked: [],
    }));
    const pending = runCentralHarnessCycle({
      perception,
      registry: registry(async () => ({})),
      brain: { propose: () => new Promise(() => {}) },
      deadlineMs: Date.now() + 10,
      settle,
    });
    await vi.advanceTimersByTimeAsync(2_010);
    const receipt = await pending;
    expect(receipt.brainCall.outcome).toBe("failed");
    expect(receipt.nextAction).toBe("halt_and_report");
    expect(settle).toHaveBeenCalledWith(receipt);
  });

  it("settles promptly when a dispatched owner ignores its signal", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(() => new Promise<Record<string, unknown>>(() => {}));
    const pending = runCentralHarnessCycle({
      perception,
      brain,
      registry: registry(execute),
      deadlineMs: Date.now() + 10,
    });
    await vi.advanceTimersByTimeAsync(2_010);
    const receipt = await pending;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipt.steps[0].status).toBe("ran_failed");
    expect(receipt.steps[0].failureReason).toContain("cleanup_unconfirmed");
    expect(receipt.nextAction).toBe("halt_and_report");
  });

  it("propagates caller cancellation and does not dispatch subsequent owners", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (_args: Readonly<Record<string, unknown>>, signal: AbortSignal) => {
      controller.abort(new Error("operator cancelled"));
      signal.throwIfAborted();
      return {};
    });
    const receipt = await runCentralHarnessCycle({
      perception,
      brain,
      registry: registry(execute),
      signal: controller.signal,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipt.steps.map((step) => step.status)).toEqual(["ran_failed", "ran_failed"]);
    expect(receipt.nextAction).toBe("halt_and_report");
  });

  it("does not call the brain when already cancelled", async () => {
    const propose = vi.fn(brain.propose);
    const receipt = await runCentralHarnessCycle({
      perception,
      brain: { propose },
      registry: registry(async () => ({})),
      signal: AbortSignal.abort(new Error("cancelled")),
    });
    expect(propose).not.toHaveBeenCalled();
    expect(receipt.brainCall.outcome).toBe("failed");
  });

  it("blocks brain dispatch when the fixed decision context exceeds its byte budget", async () => {
    const propose = vi.fn(brain.propose);
    const receipt = await runCentralHarnessCycle({
      perception: { ...perception, ownerTotals: { data: "x".repeat(12000) } },
      brain: { propose },
      registry: registry(async () => ({})),
    });
    expect(propose).not.toHaveBeenCalled();
    expect(receipt.contextBudget?.overBudget).toBe(true);
    expect(receipt.brainCall).toMatchObject({
      outcome: "blocked",
      reason: "context_budget_exceeded",
    });
    expect(receipt.steps).toEqual([]);
    expect(receipt.nextAction).toBe("halt_and_report");
  });

  it("requests explicit follow-up for failed dispatch", async () => {
    const receipt = await runCentralHarnessCycle({
      perception,
      brain,
      registry: registry(async () => {
        throw new Error("fixture dispatch failure");
      }),
    });
    expect(receipt.nextAction).toBe("follow_up_on_failed_dispatch");
    expect(receipt.steps[0].failureReason).toContain("fixture dispatch failure");
  });
});

describe("scope-bound evidence retention", () => {
  const capabilities = new Set(["fixture"]);
  async function observe(args: Readonly<Record<string, unknown>>, value: number, at: string) {
    return runCentralHarnessCycle({
      perception: { ...perception, observedAt: at },
      brain: {
        propose: async () => ({
          kind: "proposed" as const,
          provider: "fixture",
          modelId: "fixture",
          plan: { actions: [{ ownerId: "fixture", args }], note: "read scope" },
        }),
      },
      registry: registry(async () => ({ receipt: { value, sourceRef: `source-${value}` } })),
      capabilityOwnerIds: capabilities,
    });
  }

  it("retains distinct scopes across no-op decisions without refreshing their clocks", async () => {
    const first = await observe({ directory: "a", page: 1 }, 7, "2026-09-21T00:00:00Z");
    const second = await observe({ directory: "b", page: 1 }, 11, "2026-09-21T01:00:00Z");
    const idle = { ...second, runId: "idle", steps: [], observedAt: "2026-09-21T02:00:00Z" };
    const outcomes = compactReceipts([first, second, idle], 10, capabilities).flatMap(
      (entry) => entry.outcomes,
    );
    expect(outcomes.map((item) => item.outcome?.value)).toEqual([7, 11]);
    expect(outcomes.map((item) => item.args?.directory)).toEqual(["a", "b"]);
    expect(outcomes.map((item) => item.sourceObservedAt)).toEqual([
      first.observedAt,
      second.observedAt,
    ]);
    expect(outcomes[0].argsSha256).not.toBe(outcomes[1].argsSha256);
  });

  it("retains current scope results beyond the count window without growing the budget", async () => {
    const first = await observe({ directory: "a", page: 1 }, 7, "2026-09-21T00:00:00Z");
    const second = await observe({ directory: "b", page: 1 }, 11, "2026-09-21T01:00:00Z");
    const idle = Array.from({ length: 20 }, (_, index) => ({
      ...second,
      runId: `idle-${index}`,
      observedAt: new Date(Date.parse(second.observedAt) + (index + 1) * 60_000).toISOString(),
      steps: [],
    }));
    const backlog = compactReceipts([first, second, ...idle], 10, capabilities);
    const outcomes = backlog.flatMap((entry) => entry.outcomes);
    expect(outcomes.map((item) => item.outcome?.value)).toEqual([7, 11]);
    expect(outcomes.map((item) => item.sourceObservedAt)).toEqual([
      first.observedAt,
      second.observedAt,
    ]);
    expect(backlog).toHaveLength(10);
    expect(backlog.at(-1)?.atMs).toBe(Date.parse(idle.at(-1)!.observedAt));
    expect(backlog[0].backlogEntriesOmitted).toBe(12);
    expect(Buffer.byteLength(JSON.stringify(backlog))).toBeLessThanOrEqual(8_500);
  });

  it("retains the latest failure rather than resurrecting success across a count window", async () => {
    const success = await observe({ page: 1 }, 19, perception.observedAt);
    const failure: CentralRunReceipt = {
      ...success,
      runId: "failed",
      steps: success.steps.map((step) => ({
        ...step,
        status: "ran_failed",
        outcome: undefined,
        failureReason: "source unavailable",
      })),
    };
    const idle = Array.from({ length: 20 }, (_, index) => ({
      ...success,
      runId: `idle-${index}`,
      steps: [],
    }));
    const backlog = compactReceipts([success, failure, ...idle], 10, capabilities);
    const current = backlog
      .flatMap((entry) => entry.outcomes)
      .filter((step) => !step.outcomeDroppedKeys?.includes("outcome_superseded_in_backlog"));
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ status: "ran_failed", reason: "source unavailable" });
    expect(backlog.flatMap((entry) => entry.outcomes).every((step) => !step.outcome)).toBe(true);
  });

  it("drops no-op headers before current results when bytes, not count, are exhausted", async () => {
    const read = await observe({ page: 1 }, 29, perception.observedAt);
    const idle = Array.from({ length: 30 }, (_, index) => ({
      ...read,
      runId: `idle-${index}`,
      steps: [],
      brainCall: { ...read.brainCall, note: "n".repeat(600) },
    }));
    const backlog = compactReceipts([read, ...idle], 100, capabilities);
    const results = backlog.flatMap((entry) => entry.outcomes);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: { value: 29 }, sourceObservedAt: read.observedAt });
    expect(backlog[0].backlogEntriesOmitted).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(backlog))).toBeLessThanOrEqual(8_500);
  });

  it("canonicalizes argument order and supersedes only the older exact scope", async () => {
    const first = await observe({ directory: "a", page: 1 }, 7, perception.observedAt);
    const second = await observe({ page: 1, directory: "a" }, 13, perception.observedAt);
    const outcomes = compactReceipts([first, second], 10, capabilities).flatMap(
      (entry) => entry.outcomes,
    );
    expect(outcomes[0].outcome).toBeUndefined();
    expect(outcomes[0].outcomeDroppedKeys).toContain("outcome_superseded_in_backlog");
    expect(outcomes[1].outcome?.value).toBe(13);
    expect(outcomes[0].argsSha256).toBe(outcomes[1].argsSha256);
  });

  it("binds clipped arguments to the original scope and names missing values", async () => {
    const args = { page: 1, document: "证据".repeat(200) };
    const result = await observe(args, 17, perception.observedAt);
    const [outcome] = compactReceipts([result], 10, capabilities)[0].outcomes;
    expect(outcome.args).toEqual({ page: 1 });
    expect(outcome.argsDroppedKeys).toEqual(["document"]);
    expect(Buffer.byteLength(JSON.stringify(outcome.args))).toBeLessThanOrEqual(256);
    const expected = createHash("sha256")
      .update(JSON.stringify({ document: args.document, page: 1 }))
      .digest("hex");
    expect(outcome.argsSha256).toBe(expected);
  });

  it("never substitutes an older successful result after a same-scope failure", async () => {
    const success = await observe({ page: 1 }, 19, perception.observedAt);
    const failure: CentralRunReceipt = {
      ...success,
      runId: "failed",
      steps: success.steps.map((step) => ({
        ...step,
        status: "ran_failed",
        outcome: undefined,
        failureReason: "source unavailable",
      })),
    };
    const outcomes = compactReceipts([success, failure], 10, capabilities).flatMap(
      (entry) => entry.outcomes,
    );
    expect(outcomes.every((item) => item.outcome === undefined)).toBe(true);
    expect(outcomes[1].reason).toBe("source unavailable");
  });

  it("retains executed evidence when the gate blocks a duplicate proposal", async () => {
    const execute = vi.fn(async () => ({ receipt: { value: 23 } }));
    const result = await runCentralHarnessCycle({
      perception,
      brain: {
        propose: async () => ({
          kind: "proposed" as const,
          provider: "fixture",
          modelId: "fixture",
          plan: {
            note: "same-scope duplicate",
            actions: [
              { ownerId: "fixture", args: { page: 1 } },
              { ownerId: "fixture", args: { page: 1 } },
            ],
          },
        }),
      },
      registry: registry(execute),
      capabilityOwnerIds: capabilities,
    });
    const outcomes = compactReceipts([result], 10, capabilities)[0].outcomes;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(outcomes[0].outcome?.value).toBe(23);
    expect(outcomes[1].status).toBe("blocked_by_gate");
    expect(outcomes[1].reason).toBe("duplicate_action");
    expect(outcomes[0].argsSha256).toBe(outcomes[1].argsSha256);
  });

  it("marks an old governance failure superseded by an executed green check", async () => {
    const first = await observe({ page: 1 }, 1, perception.observedAt);
    const failed: CentralRunReceipt = {
      ...first,
      steps: first.steps.map((step) => ({
        ...step,
        status: "ran_failed",
        failureReason: "source unavailable",
        outcome: undefined,
      })),
    };
    const green: CentralRunReceipt = {
      ...first,
      steps: first.steps.map((step) => ({ ...step, observedOk: true })),
    };
    const backlog = compactReceipts([failed, green], 10);
    expect(backlog[0].outcomes[0].outcomeDroppedKeys).toContain("outcome_superseded_in_backlog");
    expect(backlog[1].outcomes[0]).toMatchObject({
      ownerId: "fixture",
      outcome: first.steps[0].outcome,
    });
    expect(backlog[1].approved).toEqual(["fixture"]);
  });

  it("bounds a single six-step receipt while retaining the focused page and its scope", async () => {
    const first = await observe({ page: 1 }, 1, perception.observedAt);
    const steps = Array.from({ length: 6 }, (_, index) => ({
      ...first.steps[0],
      stepId: `step-${index}`,
      ownerId: index === 0 ? "finance_bar_ledger" : `fixture-${index}`,
      args: { input: "a".repeat(240) },
      outcome: { data: "a".repeat(index === 0 ? 4080 : 496) },
    }));
    const receipt = { ...first, steps, brainCall: { ...first.brainCall, note: "证".repeat(400) } };
    const backlog = compactReceipts([receipt], 10, new Set(steps.map((step) => step.ownerId)));
    expect(Buffer.byteLength(JSON.stringify(backlog))).toBeLessThanOrEqual(8500);
    expect(backlog[0].outcomesOmitted).toBeGreaterThan(0);
    expect(backlog[0].outcomes[0]).toMatchObject({
      ownerId: "finance_bar_ledger",
      args: steps[0].args,
      outcome: steps[0].outcome,
      sourceObservedAt: first.observedAt,
    });
    const bounded = boundPerception({
      ...perception,
      task: { objective: "a".repeat(2048), focus: "finance" },
      backlog,
    });
    expect(bounded.report.overBudget).toBe(false);
    expect(bounded.report.injectedBytes).toBeLessThanOrEqual(12000);
  });

  it.each([
    "matched",
    "unchanged",
    "different_source",
    "wrong_hash",
    "unavailable",
    "omitted",
    "older",
  ] as const)(
    "prioritizes recovered fields only after verified source recovery (%s)",
    async (condition) => {
      const original = await observe({ page: 1 }, 1, perception.observedAt);
      const id = `artifact-${"a".repeat(64)}`;
      const sha256 = "b".repeat(64);
      const recoveredId = condition === "different_source" ? `artifact-${"d".repeat(64)}` : id;
      const page: CentralRunReceipt = {
        ...original,
        steps: [
          ...(condition === "different_source"
            ? [
                {
                  ...original.steps[0],
                  ownerId: "finance_position_ledger_read",
                  outcome: { openPositionCount: 34 },
                  resultArtifact: {
                    status: "registered" as const,
                    reason: "ok",
                    id: recoveredId,
                    sha256,
                  },
                },
              ]
            : []),
          {
            ...original.steps[0],
            ownerId: "finance_bar_ledger",
            outcome: { data: "p".repeat(4080) },
            resultArtifact: {
              status: condition === "unchanged" ? "unchanged" : "registered",
              reason: "ok",
              id,
              sha256,
            },
          },
        ],
      };
      const recovered: CentralRunReceipt = {
        ...original,
        runId: "recovered",
        observedAt: condition === "older" ? "2026-09-20T23:00:00Z" : "2026-09-21T01:00:00Z",
        steps: Array.from({ length: 6 }, (_, index) => ({
          ...original.steps[0],
          stepId: `read-${index}`,
          ownerId: "artifact_memory_recall",
          args: { action: "read", id: recoveredId, field: `/value/rows/${index}` },
          outcome: {
            available: condition !== "unavailable",
            action: "read",
            artifactId: recoveredId,
            field: `/value/rows/${index}`,
            sourceSha256: condition === "wrong_hash" ? "c".repeat(64) : sha256,
            selectedValue: { index, data: "r".repeat(500) },
          },
          ...(condition === "omitted" ? { outcomeDroppedKeys: ["selectedValue"] } : {}),
        })),
      };
      const backlog = compactReceipts(
        [page, recovered],
        10,
        new Set(["finance_bar_ledger", "finance_position_ledger_read", "artifact_memory_recall"]),
      );
      expect(Buffer.byteLength(JSON.stringify(backlog))).toBeLessThanOrEqual(8500);
      const outcomes = backlog.flatMap((entry) => entry.outcomes);
      if (
        condition === "matched" ||
        condition === "unchanged" ||
        condition === "different_source"
      ) {
        expect(
          outcomes
            .filter((entry) => entry.ownerId === "artifact_memory_recall")
            .map((entry) => entry.outcome?.selectedValue),
        ).toEqual(recovered.steps.map((step) => step.outcome?.selectedValue));
        expect(backlog[0].backlogEntriesOmitted).toBe(1);
      } else {
        expect(outcomes.find((entry) => entry.ownerId === "finance_bar_ledger")?.outcome).toEqual(
          page.steps[0].outcome,
        );
      }
    },
  );
});

describe("governance result pointer budget", () => {
  it("removes even an empty result-pointer shell at the previous exact decision budget", () => {
    const finance = {
      intradayExecution: { uncertain: 1, missingOutcome: 1 },
      positionManagement: { status: "stale", needsInspection: true },
      economicFeedback: { accounts: [{ netMatchedPnl: null, costScope: "fees_not_allocated" }] },
    };
    const original: CentralPerception = {
      ...perception,
      backlog: [{ note: "x".repeat(8038) }],
      controlRoom: {
        runtimeFreshness: { note: "r".repeat(1705) },
        learningWorkflow: { note: "l".repeat(500) },
        governanceDigest: { status: "present", nextAction: "inspect actual evidence" },
        financeAutomaticLifecycle: finance,
      },
    };
    const budget = Buffer.byteLength(JSON.stringify(original));
    const expanded = {
      ...original,
      controlRoom: {
        ...original.controlRoom,
        governanceDigest: {
          ...(original.controlRoom.governanceDigest as Record<string, unknown>),
          ownerResults: [{ ownerId: "fixture", artifactId: `artifact-${"a".repeat(64)}` }],
          ownerResultsOmitted: 0,
        },
      },
    };
    const bounded = boundPerception(expanded, budget);
    expect(bounded.perception).toEqual(original);
    expect(bounded.report.overBudget).toBe(false);
    expect(bounded.report.droppedSections[0].droppedKeys).toContainEqual({
      key: "governanceDigest.ownerResults",
      bytes: Buffer.byteLength(JSON.stringify(expanded.controlRoom.governanceDigest.ownerResults)),
    });
  });
  it("drops optional pointers before hiding critical finance facts under backlog pressure", () => {
    const finance = {
      observedAt: "2026-10-06T19:19:42Z",
      intradayExecution: { status: "present", uncertain: 1, missingOutcome: 1 },
      positionManagement: { status: "stale", needsInspection: true },
      economicFeedback: {
        status: "present",
        accounts: [{ netMatchedPnl: null, costScope: "fees_not_allocated" }],
      },
      detail: "x".repeat(6000),
    };
    const owners = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`owner${i}`, "executed"]),
    );
    const input: CentralPerception = {
      ...perception,
      task: { objective: "x".repeat(600), focus: "finance" },
      ownerTotals: owners,
      backlog: [{ note: "x".repeat(8038) }],
      controlRoom: {
        runtimeFreshness: { note: "r".repeat(500) },
        learningWorkflow: { note: "l".repeat(500) },
        financeAutomaticLifecycle: finance,
        governanceDigest: {
          status: "present",
          nextAction: "inspect actual evidence",
          note: "g".repeat(250),
          ownerResults: Array.from({ length: 4 }, (_, i) => ({
            ownerId: `owner${i}`,
            status: "registered",
            artifactId: `artifact-${"a".repeat(64)}`,
            sourceSha256: "a".repeat(64),
            sourceObservedAt: "2026-10-06T19:19:42Z",
            sourceTimeBasis: "payload.checkedAt",
          })),
          ownerResultsOmitted: 2,
        },
      },
    };
    const bounded = boundPerception(input);
    expect(bounded.report.overBudget).toBe(false);
    const projected = bounded.perception.controlRoom.financeAutomaticLifecycle;
    expect(projected).toMatchObject({
      intradayExecution: { uncertain: 1, missingOutcome: 1 },
      positionManagement: { status: "stale", needsInspection: true },
      economicFeedback: { accounts: [{ netMatchedPnl: null, costScope: "fees_not_allocated" }] },
    });
    const digest = bounded.perception.controlRoom.governanceDigest as Record<string, unknown>;
    expect((digest.ownerResults as unknown[]).length).toBeLessThan(4);
    expect(digest.ownerResultsOmitted).toBeGreaterThan(2);
    expect(boundPerception(bounded.perception).perception).toEqual(bounded.perception);
    expect(input.controlRoom.financeAutomaticLifecycle).toBe(finance);
  });
});

describe("bounded central coordination", () => {
  const propose = (actions: { ownerId: string; args?: Record<string, unknown> }[]) => ({
    propose: async () => ({
      kind: "proposed" as const,
      provider: "fixture",
      modelId: "fixture",
      plan: { actions, note: "bounded fixture" },
    }),
  });
  it.each([false, true])(
    "blocks only exact canonical duplicates after normal approval (planOnly=%s)",
    async (planOnly) => {
      const execute = vi.fn(async () => ({ observedOk: true, receipt: { status: "ready" } }));
      const tools = registry(execute);
      const approve = vi.spyOn(tools.get("fixture")!, "approve");
      const receipt = await runCentralHarnessCycle({
        perception,
        registry: tools,
        planOnly,
        capabilityOwnerIds: new Set(["fixture"]),
        brain: propose([
          { ownerId: "fixture", args: { account: "a", cursor: "1", nested: { a: 1, b: 2 } } },
          { ownerId: "fixture", args: { nested: { b: 2, a: 1 }, cursor: "1", account: "a" } },
          { ownerId: "fixture", args: { account: "a", cursor: "2", nested: { a: 1, b: 2 } } },
          { ownerId: "fixture", args: { account: "b", cursor: "1", nested: { a: 1, b: 2 } } },
        ]),
      });
      expect(approve).toHaveBeenCalledTimes(4);
      expect(execute).toHaveBeenCalledTimes(3);
      expect(receipt.steps.map((step) => step.status)).toEqual([
        "ran_ok",
        "blocked_by_gate",
        "ran_ok",
        "ran_ok",
      ]);
      expect(receipt.steps[1].gateReason).toBe("duplicate_action");
      expect(receipt.steps[0].outcome).toBeDefined();
    },
  );
  it("follows actual capability results within production continuation bounds", async () => {
    const options = {
      perception,
      brain: propose([{ ownerId: "fixture" }]),
      registry: registry(async () => ({ receipt: { status: "ready", quantity: 10 } })),
      capabilityOwnerIds: new Set(["fixture"]),
      planOnly: true,
    };
    const first = await runCentralHarnessCycle(options);
    expect(first.nextAction).toBe("follow_up_on_capability_results");
    expect(nextCycleContinuation(first, 1, 3)).toEqual({
      run: true,
      because: "capability_results",
    });
    expect(nextCycleContinuation(first, 1, 1)).toEqual({
      run: false,
      because: "max_cycles_reached",
    });
    expect(compactReceipts([first], 3, new Set(["fixture"]))[0].outcomes[0].outcome).toMatchObject({
      status: "ready",
      quantity: 10,
    });
    const repeated = await runCentralHarnessCycle(options);
    expect(nextCycleContinuation(repeated, 2, 3, first)).toEqual({
      run: false,
      because: "unchanged_result",
    });
    const gated = {
      ...first,
      nextAction: "review_blocked_proposals",
      steps: first.steps.map((step) => ({
        ...step,
        status: "blocked_by_gate" as const,
        gateReason: "denied",
      })),
    };
    expect(nextCycleContinuation(gated, 2, 3, gated)).toEqual({
      run: false,
      because: "unchanged_failure",
    });
    const failed = {
      ...gated,
      nextAction: "follow_up_on_failed_dispatch",
      steps: first.steps.map((step) => ({
        ...step,
        status: "ran_failed" as const,
        failureReason: "unavailable",
      })),
    };
    expect(nextCycleContinuation(failed, 2, 3, failed)).toEqual({
      run: false,
      because: "unchanged_failure",
    });
    const stopped = await runCentralHarnessCycle({ ...options, brain: propose([]) });
    expect(nextCycleContinuation(stopped, 2, 3, first)).toEqual({
      run: false,
      because: "nothing_left_to_follow_up",
    });
    const planned = await runCentralHarnessCycle({
      ...options,
      capabilityOwnerIds: new Set<string>(),
    });
    expect(planned.steps[0].status).toBe("approved");
    expect(planned.nextAction).toBe("continue");
    const unclassified = await runCentralHarnessCycle({
      ...options,
      planOnly: false,
      capabilityOwnerIds: undefined,
    });
    expect(unclassified.nextAction).toBe("follow_up_on_owner_results");
  });
  it("uses the production continuation gate to consume absent then ready capability receipts", async () => {
    const receipts: CentralRunReceipt[] = [];
    const capabilities = new Set(["fixture"]);
    const calls: string[] = [];
    const execute = async (args: Readonly<Record<string, unknown>>) => {
      calls.push(String(args.directory));
      return {
        receipt:
          args.directory === "primary" ? { status: "absent" } : { status: "ready", quantity: 10 },
      };
    };
    for (let cycle = 1; cycle <= 3; cycle++) {
      const backlog = compactReceipts(receipts, 3, capabilities);
      const status = backlog.at(-1)?.outcomes[0]?.outcome?.status;
      const receipt = await runCentralHarnessCycle({
        perception: { ...perception, backlog },
        registry: registry(execute),
        planOnly: true,
        capabilityOwnerIds: capabilities,
        brain: propose(
          status === "ready"
            ? []
            : [
                {
                  ownerId: "fixture",
                  args: { directory: status === "absent" ? "backup" : "primary" },
                },
              ],
        ),
      });
      receipts.push(receipt);
      if (!nextCycleContinuation(receipt, cycle, 3, receipts.at(-2)).run) {
        break;
      }
    }
    expect(calls).toEqual(["primary", "backup"]);
    expect(receipts).toHaveLength(3);
    expect(receipts.at(-1)?.actionsProposed).toBe(0);
  });
});

it.each(["metadata_first", "feedback_first"] as const)(
  "carries research composition through the fixed step budget with %s",
  async (order) => {
    const composition = {
      selectionSource: "caller_proposal",
      primaryModules: ["macro_rates_inflation"],
      moduleToolsDispatched: false,
      replanStatus: "blocked_hard",
      nextAction: "stop",
      hardFailureCount: 1,
      remainingSoftReplans: 0,
    };
    const metadata = {
      receiptPath: "/private/" + "x".repeat(1000),
      receiptSha256: "a".repeat(64),
      toolInvocation: { diagnostic: "x".repeat(1000) },
      reviewFeedback: { diagnostic: "x".repeat(1000) },
    };
    const feedback = { status: "needs_review", composition, missingEvidence: ["closure_missing"] };
    const execute = async () =>
      order === "metadata_first" ? { ...metadata, ...feedback } : { ...feedback, ...metadata };
    const spec = { ...registry(execute).get("fixture")!, ownerId: "finance_research_run" };
    const receipt = await runCentralHarnessCycle({
      perception,
      brain: {
        propose: async () => ({
          kind: "proposed",
          provider: "fixture",
          modelId: "fixture",
          plan: { actions: [{ ownerId: spec.ownerId, args: {} }], note: "read planning result" },
        }),
      },
      registry: new Map([[spec.ownerId, spec]]),
    });
    expect(receipt.steps[0].outcome).toMatchObject(feedback);
    expect(receipt.steps[0].outcome?.receiptSha256).toBe(metadata.receiptSha256);
    expect(Buffer.byteLength(JSON.stringify(receipt.steps[0].outcome))).toBeLessThanOrEqual(512);
    expect(receipt.steps[0].outcomeDroppedKeys).toEqual(
      expect.arrayContaining(["receiptPath", "toolInvocation", "reviewFeedback"]),
    );
    const backlog = compactReceipts([receipt], 5);
    expect(backlog[0].outcomes[0].outcome?.composition).toEqual(composition);
    expect(backlog[0].outcomes[0].outcome?.missingEvidence).toEqual(["closure_missing"]);
  },
);
