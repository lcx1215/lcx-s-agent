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

it("keeps active and queued account work visible even while the main cycle is idle", async () => {
  const held = deferred(),
    entered = deferred();
  const observations: unknown[] = [];
  const lane = createFinanceSchedulerReconciliationWake({
    signal: new AbortController().signal,
    minIntervalMs: 0,
    reconcile: async () => {},
    onError: (error) => {
      throw error;
    },
    onStateChange: (state) => {
      observations.push(state);
    },
  });
  const trading = lane.run(async () => {
    entered.resolve();
    await held.promise;
  });
  await entered.promise;
  expect(lane.getStatus()).toMatchObject({
    activeWork: "trading",
    queuedWork: 0,
    reconciliationPending: false,
  });
  for (let i = 0; i < 20; i++) {
    lane.request();
  }
  expect(lane.getStatus()).toMatchObject({
    activeWork: "trading",
    queuedWork: 1,
    reconciliationPending: true,
  });
  held.resolve();
  await trading;
  await lane.flush();
  expect(lane.getStatus()).toMatchObject({
    activeWork: null,
    queuedWork: 0,
    reconciliationPending: false,
  });
  expect(observations).toContainEqual(expect.objectContaining({ activeWork: "reconciliation" }));
});

it("does not start account work when its initial progress observation cannot be persisted", async () => {
  let fail = true,
    calls = 0;
  const lane = createFinanceSchedulerReconciliationWake({
    signal: new AbortController().signal,
    reconcile: async () => {},
    onError: () => {},
    onStateChange: () => {
      if (fail) {
        throw new Error("progress unavailable");
      }
    },
  });
  await expect(
    lane.run(async () => {
      calls++;
    }),
  ).rejects.toThrow("progress unavailable");
  expect(calls).toBe(0);
  expect(lane.getStatus().queuedWork).toBe(0);
  fail = false;
  await lane.run(async () => {
    calls++;
  });
  expect(calls).toBe(1);
});

it("rejects work before dispatch if the active-work observation fails after successful queue admission", async () => {
  let observations = 0,
    calls = 0;
  const lane = createFinanceSchedulerReconciliationWake({
    signal: new AbortController().signal,
    reconcile: async () => {},
    onError: () => {},
    onStateChange: () => {
      if (++observations === 2) {
        throw new Error("active observation unavailable");
      }
    },
  });
  await expect(
    lane.run(async () => {
      calls++;
    }),
  ).rejects.toThrow("active observation unavailable");
  expect(calls).toBe(0);
  expect(lane.getStatus()).toMatchObject({ activeWork: null, queuedWork: 0 });
  await lane.run(async () => {
    calls++;
  });
  expect(calls).toBe(1);
});
