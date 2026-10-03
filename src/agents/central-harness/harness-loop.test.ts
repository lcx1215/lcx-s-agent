import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundPerception,
  runCentralHarnessCycle,
  nextCycleContinuation,
  compactReceipts,
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

describe("central cycle cancellation and failure closure", () => {
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
    expect(backlog[1].outcomes).toEqual([]);
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
    expect(unclassified.nextAction).toBe("continue");
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
