import { expect, it, vi } from "vitest";
import { financeIntradayMonitorOrder } from "../../scripts/operator/lcx-finance-scheduler.js";

it("revisits owned exits before discovery when a slow review crosses the closing bar", async () => {
  let now = Date.parse("2026-10-14T19:54:00Z");
  const readOwnedInstruments = vi.fn(async () => ["O", "VCLT"]);
  const onBarChange = vi.fn(async () => {
    dispatched.push("MANAGED_EXIT");
  });
  const order = financeIntradayMonitorOrder({
    instruments: ["DISCOVERY1", "DISCOVERY2", "O", "VCLT"],
    intervalSeconds: 300,
    readOwnedInstruments,
    onBarChange,
    signal: new AbortController().signal,
    now: () => now,
  });
  const dispatched: string[] = [];
  for await (const symbol of order) {
    dispatched.push(symbol);
    if (symbol === "DISCOVERY1") {
      // The first holds were before the exit bar closed; discovery consumed time.
      now = Date.parse("2026-10-14T19:55:30Z");
    }
  }
  expect(dispatched).toEqual([
    "O",
    "VCLT",
    "DISCOVERY1",
    "MANAGED_EXIT",
    "O",
    "VCLT",
    "DISCOVERY2",
  ]);
  expect(readOwnedInstruments).toHaveBeenCalledTimes(2);
  expect(onBarChange).toHaveBeenCalledTimes(1);
});

it("keeps foreign/core or out-of-scope symbols outside the original monitor universe", async () => {
  const dispatched: string[] = [];
  for await (const symbol of financeIntradayMonitorOrder({
    instruments: ["DISCOVERY", "O", "O"],
    intervalSeconds: 300,
    readOwnedInstruments: async () => ["FOREIGN", "CORE", "O", "O"],
    signal: new AbortController().signal,
    now: () => 0,
  })) {
    dispatched.push(symbol);
  }
  expect(dispatched).toEqual(["O", "DISCOVERY"]);
});

it("does not dispatch after cancellation during the ownership read", async () => {
  const controller = new AbortController();
  const order = financeIntradayMonitorOrder({
    instruments: ["O"],
    intervalSeconds: 300,
    signal: controller.signal,
    readOwnedInstruments: async () => {
      controller.abort();
      return ["O"];
    },
  });
  expect(await order.next()).toEqual({ done: true, value: undefined });
});

it("does not silently fall back to discovery if the ownership ledger cannot be read", async () => {
  const order = financeIntradayMonitorOrder({
    instruments: ["DISCOVERY", "O"],
    intervalSeconds: 300,
    signal: new AbortController().signal,
    readOwnedInstruments: async () => {
      throw new Error("ledger conflict");
    },
  });
  await expect(order.next()).rejects.toThrow("ledger conflict");
});

it("hands off at a completed operation and retains pending candidates when a cycle becomes due", async () => {
  let due = false;
  let pending: readonly string[] = [];
  const visited: string[] = [];
  for await (const symbol of financeIntradayMonitorOrder({
    instruments: ["OWN", "DISCOVERY1", "DISCOVERY2"],
    intervalSeconds: 300,
    signal: new AbortController().signal,
    now: () => 0,
    readOwnedInstruments: async () => ["OWN"],
    shouldYield: () => due,
    onYield: (remaining) => {
      pending = remaining;
    },
  })) {
    visited.push(symbol);
    due = true;
  }
  expect(visited).toEqual(["OWN"]);
  expect(pending).toEqual(["DISCOVERY1", "DISCOVERY2"]);
});
