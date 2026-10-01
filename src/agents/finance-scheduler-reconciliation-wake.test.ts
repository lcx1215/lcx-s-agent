import { describe, expect, it } from "vitest";
import { createFinanceSchedulerReconciliationWake } from "./finance-scheduler-reconciliation-wake.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("resident reconciliation wake", () => {
  it("coalesces events behind an executing account owner", async () => {
    const abort = new AbortController();
    const held = deferred();
    const entered = deferred();
    const observed: string[] = [];
    const lane = createFinanceSchedulerReconciliationWake({
      signal: abort.signal,
      minIntervalMs: 0,
      reconcile: async () => {
        observed.push("reconcile");
      },
      onError: () => {
        throw new Error("unexpected failure");
      },
    });
    const execution = lane.run(async () => {
      observed.push("execution:start");
      entered.resolve();
      await held.promise;
      observed.push("execution:end");
    });
    await entered.promise;
    for (let i = 0; i < 100; i++) {
      lane.request();
    }
    expect(observed).toEqual(["execution:start"]);
    held.resolve();
    await execution;
    await lane.flush();
    expect(observed).toEqual(["execution:start", "execution:end", "reconcile"]);
  });

  it("queues a fresh event arriving during reconciliation without starving account tasks", async () => {
    const held = deferred();
    const entered = deferred();
    const finished = deferred();
    const observed: string[] = [];
    let attempts = 0;
    const lane = createFinanceSchedulerReconciliationWake({
      signal: new AbortController().signal,
      minIntervalMs: 0,
      reconcile: async () => {
        attempts++;
        observed.push(`reconcile:${attempts}`);
        if (attempts === 1) {
          entered.resolve();
          await held.promise;
        } else {
          finished.resolve();
        }
      },
      onError: () => {
        throw new Error("unexpected failure");
      },
    });
    lane.request();
    await entered.promise;
    lane.request();
    lane.request();
    const work = lane.run(async () => {
      observed.push("account-task");
    });
    held.resolve();
    await work;
    await finished.promise;
    await lane.flush();
    expect(observed).toEqual(["reconcile:1", "account-task", "reconcile:2"]);
  });

  it("does not retry an error without a new hint and keeps the lane usable", async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const lane = createFinanceSchedulerReconciliationWake({
      signal: new AbortController().signal,
      minIntervalMs: 0,
      reconcile: async () => {
        attempts++;
        throw new Error("broker unavailable");
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    lane.request();
    await lane.flush();
    expect(attempts).toBe(1);
    expect(errors).toHaveLength(1);
    expect(await lane.run(async () => "next tick")).toBe("next tick");
  });

  it("cancels queued wake work and never re-enters a held account task", async () => {
    const abort = new AbortController();
    const held = deferred();
    const entered = deferred();
    let reads = 0;
    const lane = createFinanceSchedulerReconciliationWake({
      signal: abort.signal,
      minIntervalMs: 0,
      reconcile: async () => {
        reads++;
      },
      onError: () => {
        throw new Error("unexpected failure");
      },
    });
    const work = lane.run(async () => {
      entered.resolve();
      await held.promise;
    });
    await entered.promise;
    lane.request();
    abort.abort();
    held.resolve();
    await work;
    await lane.flush();
    lane.request();
    await lane.flush();
    expect(reads).toBe(0);
  });
});
