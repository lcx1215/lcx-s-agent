import { describe, expect, it } from "vitest";
import {
  buildFinanceExecutionReceipt,
  type FinanceExecutionReceipt,
} from "./finance-execution-adapter.js";
import { projectFinanceIntradayOwnedPositions } from "./finance-intraday-position.js";
import type { FinanceOwnedProtectionExitFact } from "./finance-owned-protection-exits.js";

function receipt(id: string, side: "buy" | "sell", quantity: number, price: number, at: string) {
  return buildFinanceExecutionReceipt({
    intent: {
      intentId: `intent:intraday-${id}`,
      instrument: "SPY",
      side,
      orderType: "market",
      quantity,
      referencePrice: price,
      referencePriceAt: at,
      runAuthorizationId: "fixture",
      rationale: "owned position regression fixture",
    },
    adapter: { id: "alpaca-venue", venue: "alpaca:paper", kind: "venue" },
    fill: {
      filledQuantity: quantity,
      fillPrice: price,
      filledAt: at,
      venueRef: `alpaca:paper:${id}`,
      terminalOrderIdentity: { orderId: id, terminal: true },
    },
    recordedAt: at,
    accountId: "paper-account",
  });
}

function stop(
  entry: FinanceExecutionReceipt,
  quantity: number,
  at: string,
): FinanceOwnedProtectionExitFact {
  return {
    accountId: "paper-account",
    venue: "alpaca:paper",
    instrument: "SPY",
    entryReceiptId: entry.receiptId,
    entryIntentId: entry.intentId,
    parentOrderId: entry.fill.terminalOrderIdentity!.orderId,
    childOrderId: `stop-${entry.receiptId}`,
    entryFilledQuantity: entry.fill.filledQuantity,
    filledQuantity: quantity,
    parentOrderHistoryRef: "a".repeat(64),
    childOrderHistoryRefs: ["b".repeat(64)],
    fills: [
      {
        activityId: `activity-${entry.receiptId}`,
        quantity,
        price: 99,
        occurredAt: at,
        sourceFactRef: "c".repeat(64),
        historyRef: "d".repeat(64),
      },
    ],
  };
}

describe("intraday inventory with owned native protection fills", () => {
  it("keeps a later same-symbol entry bound to its own cost and intent after the old stop closes", () => {
    const oldEntry = receipt("old", "buy", 2, 100, "2026-10-01T14:00:00Z");
    const newEntry = receipt("new", "buy", 3, 120, "2026-10-02T14:00:00Z");
    const exits = [stop(oldEntry, 2, "2026-10-02T13:45:00Z")];
    const original = JSON.stringify([oldEntry, newEntry]);
    const projected = projectFinanceIntradayOwnedPositions([newEntry, oldEntry], exits);
    expect(projected.positions).toEqual([{ instrument: "SPY", quantity: 3, averageCost: 120 }]);
    expect(projected.openLots).toMatchObject([{ entryReceiptId: newEntry.receiptId, quantity: 3 }]);
    expect(projectFinanceIntradayOwnedPositions([oldEntry, newEntry], exits)).toEqual(projected);
    expect(JSON.stringify([oldEntry, newEntry])).toBe(original);
    expect(projectFinanceIntradayOwnedPositions([newEntry], exits).positions[0].quantity).toBe(3);
  });

  it("combines a partial native stop and an ordinary terminal exit without borrowing another lot", () => {
    const entry = receipt("entry", "buy", 3, 100, "2026-10-02T14:00:00Z");
    const exit = receipt("manual-exit", "sell", 2, 102, "2026-10-02T15:00:00Z");
    const projected = projectFinanceIntradayOwnedPositions(
      [entry, exit],
      [stop(entry, 1, "2026-10-02T14:30:00Z")],
    );
    expect(projected.positions[0].quantity).toBe(0);
    expect(projected.openLots).toEqual([]);
  });

  it("refuses a native fill that exceeds its remaining owned lot after another exit", () => {
    const entry = receipt("entry", "buy", 3, 100, "2026-10-02T14:00:00Z");
    const exit = receipt("manual-exit", "sell", 2, 102, "2026-10-02T14:30:00Z");
    expect(() =>
      projectFinanceIntradayOwnedPositions([entry, exit], [stop(entry, 2, "2026-10-02T15:00:00Z")]),
    ).toThrow("owned protection fill exceeds its remaining entry lot");
  });
});
