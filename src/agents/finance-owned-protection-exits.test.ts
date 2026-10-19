import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientOrderIdentity } from "./finance-alpaca-execution-adapter.js";
import { readFinanceBrokerExitFeedback } from "./finance-broker-profit-feedback.js";
import { buildFinanceExecutionReceipt } from "./finance-execution-adapter.js";
import {
  FINANCE_EXECUTION_RECEIPT_SCHEMA,
  type FinanceExecutionReceipt,
} from "./finance-execution-adapter.js";
import { appendFinanceIntradayDecision } from "./finance-intraday-control-ledger.js";
import {
  FinanceOwnedProtectionExitEvidenceError,
  readFinanceOwnedProtectionExitFacts,
} from "./finance-owned-protection-exits.js";
import {
  appendFinanceExecutionReceipt,
  appendFinanceBrokerHistory,
  readFinancePositionRecords,
} from "./finance-position-ledger.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function entryReceipt(overrides: Partial<FinanceExecutionReceipt> = {}): FinanceExecutionReceipt {
  const filledAt = "2026-10-02T14:00:00.000Z";
  return {
    schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
    receiptId: "entry-receipt",
    accountId: "paper-account",
    intentId: "entry-intent",
    runAuthorizationId: "run-1",
    adapterId: "alpaca-venue",
    adapterKind: "venue",
    venue: "alpaca:paper",
    instrument: "UTHR",
    side: "buy",
    orderType: "market",
    quantity: 2,
    referencePrice: 100,
    referencePriceAt: filledAt,
    notional: 200,
    fill: {
      filledQuantity: 2,
      fillPrice: 100,
      filledAt,
      venueRef: "alpaca:paper:parent-order",
      terminalOrderIdentity: { orderId: "parent-order", terminal: true },
    },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt: filledAt,
    ...overrides,
  };
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "owned-protection-exits-"));
  directories.push(directory);
  return { directory, accountId: "paper-account" };
}

async function appendHistory(
  directory: string,
  query: string,
  payload: readonly Record<string, unknown>[],
  accountId = "paper-account",
  venue = "alpaca:paper",
) {
  await appendFinanceBrokerHistory(directory, {
    kind: "broker_history",
    accountId,
    venue,
    query,
    cursor: "",
    payload: [...payload],
  });
}

function otoFacts(
  options: {
    childFilledQuantity?: string;
    childParentOrderId?: string;
    legs?: boolean;
    activityQuantities?: readonly string[];
    activityTimes?: readonly string[];
  } = {},
) {
  const child = {
    id: "stop-child",
    symbol: "UTHR",
    side: "sell",
    type: "stop",
    order_class: "oto",
    status: "partially_filled",
    qty: "2",
    filled_qty: options.childFilledQuantity ?? "1",
    filled_at: "2026-10-02T14:01:00.000Z",
    updated_at: "2026-10-02T14:01:00.000Z",
    ...(options.childParentOrderId === undefined
      ? {}
      : { parent_order_id: options.childParentOrderId }),
  };
  const parent = {
    id: "parent-order",
    symbol: "UTHR",
    side: "buy",
    type: "market",
    order_class: "oto",
    status: "filled",
    qty: "2",
    filled_qty: "2",
    filled_at: "2026-10-02T14:00:00.000Z",
    updated_at: "2026-10-02T14:00:00.000Z",
    ...(options.legs === false ? {} : { legs: [child] }),
  };
  const quantities = options.activityQuantities ?? ["0.4", "0.6"];
  const times = options.activityTimes ?? ["2026-10-02T14:01:00.000Z", "2026-10-02T14:02:00.000Z"];
  return {
    parent,
    child,
    activities: quantities.map((quantity, index) => ({
      id: `stop-fill-${index + 1}`,
      activity_type: "FILL",
      type: "partial_fill",
      order_id: "stop-child",
      symbol: "UTHR",
      side: "sell",
      qty: quantity,
      price: "99",
      transaction_time: times[index],
    })),
  };
}

describe("owned OTO protection exit projection", () => {
  it("attributes unique partial fills to the exact entry receipt without writing receipts", async () => {
    const { directory, accountId } = await fixture();
    const facts = otoFacts();
    await appendHistory(directory, "orders:nested", [facts.parent, facts.child]);
    await appendHistory(directory, "activities:first", [
      ...facts.activities,
      {
        id: "stop-fee",
        activity_type: "FEE",
        order_id: "stop-child",
        symbol: "UTHR",
        side: "sell",
        net_amount: "-0.01",
      },
    ]);
    // Re-reading the same activity page is idempotent at the fact identity level.
    await appendHistory(directory, "activities:replay", facts.activities);
    const before = await readFinancePositionRecords(directory);

    const result = await readFinanceOwnedProtectionExitFacts({
      directory,
      accountId,
      venue: "alpaca:paper",
      receipts: [entryReceipt()],
    });
    const after = await readFinancePositionRecords(directory);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      accountId,
      venue: "alpaca:paper",
      instrument: "UTHR",
      entryReceiptId: "entry-receipt",
      entryIntentId: "entry-intent",
      parentOrderId: "parent-order",
      childOrderId: "stop-child",
      entryFilledQuantity: 2,
      filledQuantity: 1,
      fills: [
        { activityId: "stop-fill-1", quantity: 0.4, price: 99 },
        { activityId: "stop-fill-2", quantity: 0.6, price: 99 },
      ],
    });
    expect(result[0]?.fills.every((fill) => fill.historyRef && fill.sourceFactRef)).toBe(true);
    expect(before.receipts).toEqual([]);
    expect(after.receipts).toEqual([]);
    expect(result).toEqual(
      await readFinanceOwnedProtectionExitFacts({
        directory,
        accountId,
        venue: "alpaca:paper",
        receipts: [entryReceipt()],
      }),
    );
  });

  it("fails closed on unsupported FILL execution types", async () => {
    const { directory, accountId } = await fixture();
    const facts = otoFacts({
      activityQuantities: ["1"],
      activityTimes: ["2026-10-02T14:01:00.000Z"],
    });
    await appendHistory(directory, "orders:nested", [facts.parent, facts.child]);
    await appendHistory(directory, "activities:unsupported", [
      { ...facts.activities[0], type: "corrected_fill" },
    ]);

    await expect(
      readFinanceOwnedProtectionExitFacts({
        directory,
        accountId,
        venue: "alpaca:paper",
        receipts: [entryReceipt()],
      }),
    ).rejects.toMatchObject({ code: "oto_child_fill_evidence_invalid" });
  });

  it("does not infer ownership from a matching symbol when nested parent legs are absent", async () => {
    const { directory, accountId } = await fixture();
    const facts = otoFacts({ legs: false });
    await appendHistory(directory, "orders:legacy", [facts.parent, facts.child]);
    await appendHistory(directory, "activities:legacy", facts.activities);

    await expect(
      readFinanceOwnedProtectionExitFacts({
        directory,
        accountId,
        venue: "alpaca:paper",
        receipts: [entryReceipt()],
      }),
    ).resolves.toEqual([]);
  });

  it("fails closed when an activity predates the entry fill", async () => {
    const { directory, accountId } = await fixture();
    const facts = otoFacts({
      activityTimes: ["2026-10-02T13:59:59.000Z", "2026-10-02T14:02:00.000Z"],
    });
    await appendHistory(directory, "orders:nested", [facts.parent, facts.child]);
    await appendHistory(directory, "activities:bad-time", facts.activities);

    await expect(
      readFinanceOwnedProtectionExitFacts({
        directory,
        accountId,
        venue: "alpaca:paper",
        receipts: [entryReceipt()],
      }),
    ).rejects.toMatchObject({
      name: "FinanceOwnedProtectionExitEvidenceError",
      code: "oto_child_fill_outside_entry_window",
    } satisfies Partial<FinanceOwnedProtectionExitEvidenceError>);
  });

  it("rejects disagreement between declared child filled quantity and real activities", async () => {
    const { directory, accountId } = await fixture();
    const facts = otoFacts({ childFilledQuantity: "1.5" });
    await appendHistory(directory, "orders:nested", [facts.parent, facts.child]);
    await appendHistory(directory, "activities:mismatch", facts.activities);

    await expect(
      readFinanceOwnedProtectionExitFacts({
        directory,
        accountId,
        venue: "alpaca:paper",
        receipts: [entryReceipt()],
      }),
    ).rejects.toMatchObject({ code: "oto_child_fill_quantity_mismatch" });
  });

  it("refuses protective fills exceeding the bound entry lot", async () => {
    const { directory, accountId } = await fixture();
    const facts = otoFacts({
      childFilledQuantity: "1.5",
      activityQuantities: ["1.5"],
      activityTimes: ["2026-10-02T14:01:00.000Z"],
    });
    const smallerEntry = entryReceipt({
      quantity: 1,
      notional: 100,
      fill: {
        filledQuantity: 1,
        fillPrice: 100,
        filledAt: "2026-10-02T14:00:00.000Z",
        venueRef: "alpaca:paper:parent-order",
        terminalOrderIdentity: { orderId: "parent-order", terminal: true },
      },
    });
    facts.parent.filled_qty = "1";
    facts.parent.qty = "1";
    facts.child.qty = "1";
    await appendHistory(directory, "orders:nested", [facts.parent, facts.child]);
    await appendHistory(directory, "activities:over-entry", facts.activities);

    await expect(
      readFinanceOwnedProtectionExitFacts({
        directory,
        accountId,
        venue: "alpaca:paper",
        receipts: [smallerEntry],
      }),
    ).rejects.toMatchObject({ code: "oto_child_fill_quantity_mismatch" });
  });

  it("rejects a child claimed by two strategy entries and skips separately receipted sells", async () => {
    const { directory, accountId } = await fixture();
    const facts = otoFacts();
    await appendHistory(directory, "orders:nested", [facts.parent, facts.child]);
    await appendHistory(directory, "activities:child", facts.activities);
    const duplicateClaim = entryReceipt({ receiptId: "another-entry", intentId: "another-intent" });
    await expect(
      readFinanceOwnedProtectionExitFacts({
        directory,
        accountId,
        venue: "alpaca:paper",
        receipts: [entryReceipt(), duplicateClaim],
      }),
    ).rejects.toMatchObject({ code: "oto_child_claimed_by_multiple_entries" });

    const sellReceipt = entryReceipt({
      receiptId: "sell-receipt",
      intentId: "sell-intent",
      side: "sell",
      fill: {
        filledQuantity: 1,
        fillPrice: 99,
        filledAt: "2026-10-02T14:02:00.000Z",
        venueRef: "alpaca:paper:stop-child",
        terminalOrderIdentity: { orderId: "stop-child", terminal: true },
      },
    });
    await expect(
      readFinanceOwnedProtectionExitFacts({
        directory,
        accountId,
        venue: "alpaca:paper",
        receipts: [entryReceipt(), sellReceipt],
      }),
    ).resolves.toEqual([]);
  });

  it("ignores receipts outside the requested account and venue scope", async () => {
    const { directory, accountId } = await fixture();
    const facts = otoFacts();
    await appendHistory(directory, "orders:nested", [facts.parent, facts.child]);
    await appendHistory(directory, "activities:child", facts.activities);

    const wrongAccount = entryReceipt({ accountId: "other-account" });
    const wrongVenue = entryReceipt({ venue: "alpaca:live" });
    const paperReceipt = entryReceipt({ venue: "paper" });
    await expect(
      readFinanceOwnedProtectionExitFacts({
        directory,
        accountId,
        venue: "alpaca:paper",
        receipts: [wrongAccount, wrongVenue, paperReceipt],
      }),
    ).resolves.toEqual([]);
  });
});

it("does not open the broker history when there are no entry receipts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "empty-owned-exits-"));
  directories.push(directory);
  const access = vi.spyOn(fs, "access");
  try {
    await expect(
      readFinanceOwnedProtectionExitFacts({
        directory,
        accountId: "paper-account",
        venue: "alpaca:paper",
        receipts: [],
      }),
    ).resolves.toEqual([]);
    expect(access).not.toHaveBeenCalled();
  } finally {
    access.mockRestore();
  }
});
it("still validates account and cutoff on an empty ownership request", async () => {
  await expect(
    readFinanceOwnedProtectionExitFacts({
      directory: "/unused",
      accountId: "",
      venue: "alpaca:paper",
      receipts: [],
    }),
  ).rejects.toThrow("exact Alpaca paper account");
  await expect(
    readFinanceOwnedProtectionExitFacts({
      directory: "/unused",
      accountId: "paper-account",
      venue: "alpaca:paper",
      receipts: [],
      asOf: "invalid",
    }),
  ).rejects.toThrow("invalid owned exit cutoff");
});

async function restoredStopFixture(
  mode:
    | "linked"
    | "wrong_child"
    | "unknown"
    | "foreign"
    | "future"
    | "wrong_qty"
    | "confirmed_partial"
    | "hash_conflict" = "linked",
) {
  const f = await fixture();
  const old = otoFacts({ childFilledQuantity: "0", activityQuantities: [] });
  old.child.status = "canceled";
  Object.assign(old.child, {
    stop_price: "90",
    time_in_force: "gtc",
    canceled_at: "2026-10-02T14:02:00Z",
  });
  const intent = {
    intentId: "restore-exit",
    runAuthorizationId: "restore-run",
    instrument: "UTHR",
    side: "sell" as const,
    orderType: "market" as const,
    quantity: 2,
    referencePrice: 100,
    referencePriceAt: "2026-10-02T14:01:00Z",
    rationale: "fixture",
  };
  const binding = {
    accountId: f.accountId,
    venue: "alpaca:paper",
    adapterId: "alpaca-venue",
    intent,
    positionQuantity: 2,
    protectiveOrders: [
      {
        id: mode === "wrong_child" ? "unrelated" : "stop-child",
        instrument: "UTHR",
        quantity: 2,
        stopPrice: 90,
      },
    ],
  };
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        binding.accountId,
        binding.venue,
        intent.runAuthorizationId,
        intent.intentId,
      ]),
    )
    .digest("hex");
  const base = {
    id,
    run: "restore-run",
    instrument: "UTHR",
    notional: 200,
    snapshotId: "restore-snapshot",
    at: "2026-10-02T14:02:00Z",
    status: "unknown",
    binding,
  };
  const retired = {
    ...base,
    at: mode === "future" ? "2026-10-02T16:00:00Z" : "2026-10-02T14:03:00Z",
    status: "operator_retired",
    operatorRetirement: {
      authorizedBy: "user",
      authorizationRef: "fixture-authorized",
      reason: "fixture",
      brokerObservationRef: "e".repeat(64),
      retiredAt: "2026-10-02T14:03:00Z",
      originalStatus: "unknown",
    },
  };
  const fill = {
    filledQuantity: 1,
    fillPrice: 100,
    filledAt: "2026-10-02T14:02:30Z",
    venueRef: "alpaca:paper:partial-sale",
    terminalOrderIdentity: { orderId: "partial-sale", terminal: true as const },
  };
  const receipt = buildFinanceExecutionReceipt({
    intent,
    adapter: { id: "alpaca-venue", venue: "alpaca:paper", kind: "venue" },
    fill,
    recordedAt: "2026-10-02T14:02:31Z",
    accountId: f.accountId,
    identityVersion: "account-v1",
  });
  const confirmed = {
    ...base,
    at: "2026-10-02T14:02:31Z",
    status: "confirmed",
    adapterKind: "venue",
    fill,
    receipt: mode === "hash_conflict" ? { ...receipt, receiptId: "forged" } : receipt,
    receiptIdentityVersion: "account-v1",
  };
  const key = createHash("sha256")
    .update(JSON.stringify(["alpaca:paper", mode === "foreign" ? "other-account" : f.accountId]))
    .digest("hex");
  await fs.writeFile(
    path.join(f.directory, `execution-safety-${key}.jsonl`),
    [
      base,
      ...(mode === "unknown"
        ? []
        : mode === "confirmed_partial" || mode === "hash_conflict"
          ? [confirmed]
          : [retired]),
    ]
      .map((x) => JSON.stringify(x) + "\n")
      .join(""),
  );
  const restored = {
    id: "restored-stop",
    client_order_id: `${clientOrderIdentity("paper", intent)}-protect`,
    symbol: "UTHR",
    side: "sell",
    type: "stop",
    time_in_force: "gtc",
    order_class: "simple",
    qty:
      mode === "wrong_qty"
        ? "3"
        : mode === "confirmed_partial" || mode === "hash_conflict"
          ? "1"
          : "2",
    stop_price: "90",
    filled_qty: "1",
    status: "partially_filled",
    submitted_at: "2026-10-02T14:03:00Z",
    updated_at: "2026-10-02T14:04:00Z",
  };
  const activity = {
    id: "restored-fill",
    order_id: "restored-stop",
    symbol: "UTHR",
    side: "sell",
    activity_type: "FILL",
    type: "partial_fill",
    qty: "1",
    price: "89",
    transaction_time: "2026-10-02T14:04:00Z",
  };
  await appendHistory(f.directory, "orders:2026-10-02T14:05:00Z", [
    old.parent,
    old.child,
    restored,
  ]);
  await appendHistory(f.directory, "activities:2026-10-02T14:05:00Z", [activity]);
  return f;
}

it.each([
  "linked",
  "wrong_child",
  "unknown",
  "foreign",
  "future",
  "wrong_qty",
  "confirmed_partial",
  "hash_conflict",
] as const)("attributes restored stop using original ownership only: %s", async (mode) => {
  const f = await restoredStopFixture(mode);
  const read = () =>
    readFinanceOwnedProtectionExitFacts({
      ...f,
      venue: "alpaca:paper",
      receipts: [entryReceipt()],
      asOf: "2026-10-02T15:00:00Z",
    });
  if (mode === "wrong_qty") {
    await expect(read()).rejects.toMatchObject({ code: "oto_child_identity_mismatch" });
  } else {
    const facts = await read();
    expect(facts).toHaveLength(mode === "linked" || mode === "confirmed_partial" ? 1 : 0);
    if (mode === "linked" || mode === "confirmed_partial") {
      expect(facts[0]).toMatchObject({
        entryReceiptId: "entry-receipt",
        childOrderId: "restored-stop",
        filledQuantity: 1,
        restorationClaimRef: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    }
  }
});

it("passes restored-stop fills through the existing entry rule and gross-PnL feedback consumer", async () => {
  const f = await restoredStopFixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T13:59:00Z"));
  const ruleId = "opening_range_breakout_long_next_bar_v1",
    activationRef = "b".repeat(64);
  await appendFinanceIntradayDecision(f.directory, {
    signalId: "restore-entry-signal",
    instrument: "UTHR",
    sessionDate: "2026-10-02",
    action: "buy",
    reason: "opening_range_breakout",
    referencePrice: 100,
    referencePriceAt: "2026-10-02T13:59:00Z",
    datasetHeadRef: "c".repeat(64),
    strategyRule: ruleId,
    strategyBinding: {
      declarationRef: "a".repeat(64),
      activationRef,
      declaredInstruments: ["UTHR"],
      parameters: { openingRangeBars: 6, rewardRisk: 2, intervalSeconds: 300, feed: "iex" },
      scope: "strategy_universe",
    },
  });
  vi.setSystemTime(new Date("2026-10-02T15:00:00Z"));
  await appendFinanceExecutionReceipt(
    f.directory,
    entryReceipt({
      intentId: "intent:restore-entry-signal",
      decisionRef: { source: "intraday_signal", id: "restore-entry-signal" },
    }),
  );
  const result = await readFinanceBrokerExitFeedback(f.directory, {
    accountId: f.accountId,
    instrument: "UTHR",
    ruleId,
    activationRef,
    asOf: "2026-10-02T15:00:00Z",
  });
  expect(result?.entries[0]).toMatchObject({
    exitOrderId: "restored-stop",
    receiptId: "entry-receipt",
    exitQuantity: 1,
    grossPnl: -11,
    fees: "not_attributed",
    netPnl: null,
    restorationClaimRef: expect.any(String),
  });
  vi.useRealTimers();
});
