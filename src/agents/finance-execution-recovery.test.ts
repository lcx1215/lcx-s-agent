import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createPaperExecutionAdapter,
  buildFinanceExecutionReceipt,
  placeFinanceOrder,
  type FinanceOrderPlacementRequest,
} from "./finance-execution-adapter.js";
import { recoverConfirmedFinanceExecutions } from "./finance-execution-recovery.js";
import {
  createFinanceExecutionSafetyContext,
  type FinanceExecutionSafetyContextInput,
  type FinanceExecutionSafetyFacts,
  type FinanceExecutionSafetyClaim,
} from "./finance-execution-safety.js";
import {
  appendFinanceExecutionReceipt,
  appendFinancePositionMark,
  readFinanceAccountPositionLedger,
  readFinancePositionRecords,
} from "./finance-position-ledger.js";
import { stableStringify } from "./stable-stringify.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-safety-"));
  directories.push(stateDir);
  const at = new Date().toISOString();
  const expires = new Date(Date.now() + 60000).toISOString();
  const intent = {
    intentId: "one",
    runAuthorizationId: "run",
    instrument: "SPY",
    side: "buy" as const,
    orderType: "market" as const,
    quantity: 1,
    referencePrice: 100,
    referencePriceAt: at,
    rationale: "fixture",
  };
  const budget = {
    automation: "attended" as const,
    allowedInstruments: ["SPY"],
    maxOrderNotional: 1000,
    maxInstrumentNotional: 2000,
    maxOrdersPerRun: 5,
  };
  const adapter = createPaperExecutionAdapter({
    id: "paper",
    instruments: ["SPY"],
    slippageBps: 0,
  });
  const facts: FinanceExecutionSafetyFacts = {
    accountId: `account-${path.basename(stateDir)}`,
    adapterId: adapter.id,
    venue: adapter.venue,
    instrument: "SPY",
    snapshotId: "snapshot",
    source: "fixture",
    observedAt: at,
    expiresAt: expires,
    positionQuantity: 5,
    openOrderIds: [],
    unresolvedOrderIds: [],
    account: {
      status: "ACTIVE",
      tradingBlocked: false,
      equity: 10000,
      peakEquity: 10000,
      availableCash: 10000,
      currency: "USD",
      grossExposure: 500,
    },
    quote: { source: "fixture", price: 100, observedAt: at, expiresAt: expires, currency: "USD" },
    instrumentEvidence: {
      source: "fixture",
      observedAt: at,
      assetType: "spot_equity",
      fullyPaid: true,
      marginEnabled: false,
      hedged: false,
    },
  };
  const input: FinanceExecutionSafetyContextInput = {
    stateDir,
    accountId: `account-${path.basename(stateDir)}`,
    adapterId: adapter.id,
    venue: adapter.venue,
    intent,
    budget,
    policy: {
      planId: "authorization-plan",
      revision: "1",
      riskModel: "fully_funded_unhedged_spot",
      authorizedSide: "buy",
      authorizedQuantity: 5,
      expiresAt: expires,
      maxPortfolioDrawdownFraction: 0.2,
      maxGrossExposure: 3000,
      maxAccountAgeMs: 60000,
      maxQuoteAgeMs: 60000,
      maxInstrumentEvidenceAgeMs: 60000,
    },
    readFacts: async () => facts,
  };
  const request: FinanceOrderPlacementRequest = {
    mode: "live_execution",
    intent,
    budget,
    adapters: [adapter],
    executionAdapterId: adapter.id,
    committedInstrumentNotional: 0,
    ordersPlacedThisRun: 0,
  };
  return { input, request, facts, adapter };
}
async function runConfirmed() {
  const f = await fixture();
  const placed = await placeFinanceOrder({
    ...f.request,
    safetyContext: createFinanceExecutionSafetyContext(f.input),
  });
  if (!placed.receipt) {
    throw new Error("fixture placement");
  }
  const ledgerDir = path.join(f.input.stateDir, "ledger");
  const params = {
    safetyStateDir: f.input.stateDir,
    accountId: f.input.accountId,
    venue: f.adapter.venue,
    ledgerDir,
  };
  const journal = path.join(
    f.input.stateDir,
    (await fs.readdir(f.input.stateDir)).find((n) => n.endsWith(".jsonl"))!,
  );
  return { ...f, receipt: placed.receipt, params, journal };
}
it("recovers confirmed-before-SQLite crash window twice with exactly the original receipt and one fill", async () => {
  const f = await runConfirmed();
  expect((await readFinancePositionRecords(f.params.ledgerDir)).receipts).toHaveLength(0);
  const first = await recoverConfirmedFinanceExecutions(f.params);
  expect(first.replayed).toHaveLength(1);
  expect(first.failures).toEqual([]);
  const second = await recoverConfirmedFinanceExecutions(f.params);
  expect(second.alreadyRecorded).toEqual(first.replayed);
  const read = await readFinancePositionRecords(f.params.ledgerDir);
  expect(read.receipts).toEqual([f.receipt]);
  expect(
    (
      await readFinanceAccountPositionLedger(f.params.ledgerDir, {
        accountId: f.input.accountId,
        venue: f.adapter.venue,
      })
    ).ledger.positions[0].quantity,
  ).toBe(1);
});
it("delivers confirmed receipts even when a different pending broker lookup fails", async () => {
  const f = await runConfirmed();
  const entries = (await fs.readFile(f.journal, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as FinanceExecutionSafetyClaim);
  const first = entries[0];
  if (!first.binding) {
    throw new Error("fixture binding missing");
  }
  const binding = {
    ...first.binding,
    intent: { ...first.binding.intent, intentId: "other-pending" },
  };
  const id = createHash("sha256")
    .update(
      stableStringify([
        binding.accountId,
        binding.venue,
        binding.intent.runAuthorizationId,
        binding.intent.intentId,
      ]),
    )
    .digest("hex");
  await fs.appendFile(
    f.journal,
    JSON.stringify({ ...first, id, binding, status: "unknown" }) + "\n",
  );
  const before = await fs.readFile(f.journal, "utf8");
  const resolvePending = vi.fn(async () => {
    throw new Error("broker unavailable; raw details must not cross the feedback boundary");
  });
  const recovered = await recoverConfirmedFinanceExecutions({ ...f.params, resolvePending });
  expect(recovered.failures).toEqual([
    { claimId: "pending", reason: "pending_execution_resolution_unavailable" },
  ]);
  expect(recovered.pendingReconciliation).toEqual([id]);
  expect(recovered.replayed).toHaveLength(1);
  expect((await readFinancePositionRecords(f.params.ledgerDir)).receipts).toEqual([f.receipt]);
  expect(await fs.readFile(f.journal, "utf8")).toBe(before);
  const repeated = await recoverConfirmedFinanceExecutions({ ...f.params, resolvePending });
  expect(repeated.alreadyRecorded).toEqual(recovered.replayed);
  expect(repeated.pendingReconciliation).toEqual([id]);
  expect(repeated.failures).toEqual(recovered.failures);
  expect(resolvePending).toHaveBeenCalledTimes(2);
});
it("classifies confirmed venue zero-fill terminal cancellation without writing a receipt or position", async () => {
  const f = await runConfirmed();
  const entries = (await fs.readFile(f.journal, "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          id: string;
          binding: { intent: typeof f.input.intent };
          [key: string]: unknown;
        },
    );
  const claim = entries.at(-1)!;
  const fill = {
    filledQuantity: 0,
    fillPrice: 0,
    filledAt: new Date().toISOString(),
    venueRef: "alpaca:paper:zero-fill-order",
    terminalOrderIdentity: { orderId: "zero-fill-order", terminal: true as const },
  };
  const receipt = buildFinanceExecutionReceipt({
    intent: claim.binding.intent,
    adapter: { id: f.adapter.id, venue: f.adapter.venue, kind: "venue" },
    fill,
    recordedAt: f.receipt.recordedAt,
    accountId: f.input.accountId,
    identityVersion: "account-v1",
  });
  entries[entries.length - 1] = {
    ...claim,
    adapterKind: "venue",
    fill,
    receipt,
    receiptIdentityVersion: "account-v1",
  };
  await fs.writeFile(f.journal, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const first = await recoverConfirmedFinanceExecutions(f.params);
  const second = await recoverConfirmedFinanceExecutions(f.params);
  expect(first.noFill).toEqual([claim.id]);
  expect(second.noFill).toEqual([claim.id]);
  expect(first.replayed).toEqual([]);
  expect(second.alreadyRecorded).toEqual([]);
  expect((await readFinancePositionRecords(f.params.ledgerDir)).receipts).toEqual([]);
  expect(
    (
      await readFinanceAccountPositionLedger(f.params.ledgerDir, {
        accountId: f.input.accountId,
        venue: f.adapter.venue,
      })
    ).ledger.positions,
  ).toEqual([]);
});
it.each(["unknown", "reserved"])("never writes or guesses completion for %s", async (status) => {
  const f = await runConfirmed();
  const entries = (await fs.readFile(f.journal, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  await fs.writeFile(f.journal, JSON.stringify({ ...entries[0], status }) + "\n");
  const result = await recoverConfirmedFinanceExecutions(f.params);
  expect(result.pendingReconciliation).toHaveLength(1);
  expect(result.replayed).toEqual([]);
  expect((await readFinancePositionRecords(f.params.ledgerDir)).receipts).toEqual([]);
});
it("does not invent replay fields for old confirmed claims", async () => {
  const f = await runConfirmed();
  const entries = (await fs.readFile(f.journal, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  delete entries[1].receipt;
  delete entries[1].adapterKind;
  await fs.writeFile(f.journal, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  expect((await recoverConfirmedFinanceExecutions(f.params)).legacyUnsupported).toHaveLength(1);
  expect((await readFinancePositionRecords(f.params.ledgerDir)).receipts).toEqual([]);
});
it("rejects incomplete concurrent append snapshot before writing anything", async () => {
  const f = await runConfirmed();
  await fs.appendFile(f.journal, '{"id":');
  expect((await recoverConfirmedFinanceExecutions(f.params)).failures).toEqual([
    { claimId: "snapshot", reason: "journal_snapshot_unavailable" },
  ]);
  expect((await readFinancePositionRecords(f.params.ledgerDir)).receipts).toEqual([]);
});
it("reports conflicting existing receipt as pending delivery", async () => {
  const f = await runConfirmed();
  await appendFinanceExecutionReceipt(f.params.ledgerDir, { ...f.receipt, quantity: 2 });
  const result = await recoverConfirmedFinanceExecutions(f.params);
  expect(result.failures).toHaveLength(1);
  expect(result.replayed).toEqual([]);
  expect((await readFinancePositionRecords(f.params.ledgerDir)).receipts).toHaveLength(1);
});
it("account-scoped projection excludes other and legacy accounts", async () => {
  const f = await runConfirmed();
  await recoverConfirmedFinanceExecutions(f.params);
  const { accountId: _accountId, ...legacy } = f.receipt;
  await appendFinanceExecutionReceipt(f.params.ledgerDir, { ...legacy, receiptId: "legacy" });
  await appendFinanceExecutionReceipt(f.params.ledgerDir, {
    ...f.receipt,
    receiptId: "other",
    accountId: "other",
  });
  const scoped = await readFinanceAccountPositionLedger(f.params.ledgerDir, {
    accountId: f.input.accountId,
    venue: f.adapter.venue,
  });
  expect(scoped.receipts).toEqual([f.receipt]);
  expect(scoped.excludedReceiptCount).toBe(2);
  expect(scoped.unassignedReceiptCount).toBe(1);
});
it("cancelled recovery performs no database write", async () => {
  const f = await runConfirmed();
  const controller = new AbortController();
  controller.abort();
  expect(
    (await recoverConfirmedFinanceExecutions({ ...f.params, signal: controller.signal })).failures,
  ).toHaveLength(1);
  expect((await readFinancePositionRecords(f.params.ledgerDir)).receipts).toEqual([]);
});
it("recovers an explicit terminal venue fill with unchanged economic fields", async () => {
  const f = await fixture();
  const adapter = {
    ...f.adapter,
    kind: "venue" as const,
    execute: async () => ({
      filledQuantity: 1,
      fillPrice: 100,
      filledAt: f.request.intent.referencePriceAt,
      venueRef: "fixture://terminal-order",
      terminalOrderIdentity: { orderId: "venue-order", terminal: true as const },
    }),
  };
  const placed = await placeFinanceOrder({
    ...f.request,
    adapters: [adapter],
    safetyContext: createFinanceExecutionSafetyContext(f.input),
  });
  const params = {
    safetyStateDir: f.input.stateDir,
    accountId: f.input.accountId,
    venue: adapter.venue,
    ledgerDir: path.join(f.input.stateDir, "ledger"),
  };
  expect((await recoverConfirmedFinanceExecutions(params)).replayed).toHaveLength(1);
  expect((await recoverConfirmedFinanceExecutions(params)).alreadyRecorded).toHaveLength(1);
  expect((await readFinancePositionRecords(params.ledgerDir)).receipts).toEqual([placed.receipt]);
});

it("stores identical paper intents and times for two accounts without collision", async () => {
  const first = await runConfirmed();
  const second = await runConfirmed();
  const aligned = buildFinanceExecutionReceipt({
    intent: first.request.intent,
    adapter: first.adapter,
    fill: first.receipt.fill,
    recordedAt: first.receipt.recordedAt,
    accountId: second.input.accountId,
  });
  expect(aligned.receiptId).not.toBe(first.receipt.receiptId);
  await Promise.all([
    appendFinanceExecutionReceipt(first.params.ledgerDir, first.receipt),
    appendFinanceExecutionReceipt(first.params.ledgerDir, aligned),
  ]);
  for (const accountId of [first.input.accountId, second.input.accountId]) {
    const scoped = await readFinanceAccountPositionLedger(first.params.ledgerDir, {
      accountId,
      venue: first.adapter.venue,
    });
    expect(scoped.receipts).toHaveLength(1);
    expect(scoped.ledger.positions[0].quantity).toBe(1);
  }
});
it("preserves original ID when recovering a previously persisted legacy-algorithm receipt", async () => {
  const f = await runConfirmed();
  const legacy = buildFinanceExecutionReceipt({
    intent: f.request.intent,
    adapter: f.adapter,
    fill: f.receipt.fill,
    recordedAt: f.receipt.recordedAt,
    accountId: f.input.accountId,
    identityVersion: "legacy",
  });
  const entries = (await fs.readFile(f.journal, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  entries[1].receipt = legacy;
  delete entries[1].receiptIdentityVersion;
  await fs.writeFile(f.journal, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  expect((await recoverConfirmedFinanceExecutions(f.params)).replayed).toHaveLength(1);
  expect((await recoverConfirmedFinanceExecutions(f.params)).alreadyRecorded).toHaveLength(1);
  expect((await readFinancePositionRecords(f.params.ledgerDir)).receipts).toEqual([legacy]);
});

it.each(["unknown", "reserved"])(
  "reconciles %s once and delivers one terminal receipt without resubmission",
  async (status) => {
    const f = await runConfirmed();
    const first = JSON.parse((await fs.readFile(f.journal, "utf8")).split("\n")[0]);
    await fs.writeFile(f.journal, JSON.stringify({ ...first, status }) + "\n");
    const resolvePending = vi.fn(async () => ({
      ...f.receipt.fill,
      terminalOrderIdentity: { orderId: "broker-original", terminal: true as const },
    }));
    const recovered = await recoverConfirmedFinanceExecutions({ ...f.params, resolvePending });
    expect(recovered.failures).toEqual([]);
    expect(recovered.replayed).toHaveLength(1);
    expect(recovered.pendingReconciliation).toEqual([]);
    const repeated = await recoverConfirmedFinanceExecutions({ ...f.params, resolvePending });
    expect(repeated.alreadyRecorded).toEqual(recovered.replayed);
    expect(resolvePending).toHaveBeenCalledTimes(1);
    expect((await readFinancePositionRecords(f.params.ledgerDir)).receipts).toHaveLength(1);
  },
);
it("keeps unknown claims when broker has no terminal answer", async () => {
  const f = await runConfirmed();
  const first = JSON.parse((await fs.readFile(f.journal, "utf8")).split("\n")[0]);
  await fs.writeFile(
    f.journal,
    JSON.stringify({
      ...first,
      status: "unknown",
      failure: {
        phase: "execute",
        disposition: "definite_rejection",
        venueResponse: { httpStatus: 422 },
      },
    }) + "\n",
  );
  const before = await fs.readFile(f.journal, "utf8");
  const result = await recoverConfirmedFinanceExecutions({
    ...f.params,
    resolvePending: async () => undefined,
  });
  expect(result.pendingReconciliation).toHaveLength(1);
  expect(await fs.readFile(f.journal, "utf8")).toBe(before);
  expect((await readFinancePositionRecords(f.params.ledgerDir)).receipts).toHaveLength(0);
});
it.each([
  ["not_started", { phase: "not_started", disposition: "not_started" }],
  [
    "rejected",
    { phase: "execute", disposition: "definite_rejection", venueResponse: { httpStatus: 422 } },
  ],
] as const)("does not resolve or deliver terminal %s claims", async (status, failure) => {
  const f = await runConfirmed();
  const first = JSON.parse((await fs.readFile(f.journal, "utf8")).split("\n")[0]);
  await fs.writeFile(f.journal, JSON.stringify({ ...first, status, failure }) + "\n");
  const resolvePending = vi.fn(async () => undefined);
  const result = await recoverConfirmedFinanceExecutions({ ...f.params, resolvePending });
  expect(result.pendingReconciliation).toEqual([]);
  expect(result.failures).toEqual([]);
  expect(result.replayed).toEqual([]);
  expect(resolvePending).not.toHaveBeenCalled();
  expect((await readFinancePositionRecords(f.params.ledgerDir)).receipts).toEqual([]);
});
it("serializes two reconcilers so the broker resolver and journal confirmation run once", async () => {
  const f = await runConfirmed();
  const first = JSON.parse((await fs.readFile(f.journal, "utf8")).split("\n")[0]);
  await fs.writeFile(f.journal, JSON.stringify({ ...first, status: "unknown" }) + "\n");
  const resolvePending = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      ...f.receipt.fill,
      terminalOrderIdentity: { orderId: "original", terminal: true as const },
    };
  });
  const results = await Promise.all([
    recoverConfirmedFinanceExecutions({ ...f.params, resolvePending }),
    recoverConfirmedFinanceExecutions({ ...f.params, resolvePending }),
  ]);
  expect(results.flatMap((result) => result.failures)).toEqual([]);
  expect(resolvePending).toHaveBeenCalledTimes(1);
  expect((await readFinancePositionRecords(f.params.ledgerDir)).receipts).toHaveLength(1);
});
it("cancellation preserves an unknown claim even if its resolver ignores the signal", async () => {
  const f = await runConfirmed();
  const first = JSON.parse((await fs.readFile(f.journal, "utf8")).split("\n")[0]);
  await fs.writeFile(f.journal, JSON.stringify({ ...first, status: "unknown" }) + "\n");
  const before = await fs.readFile(f.journal, "utf8");
  const controller = new AbortController();
  const result = await recoverConfirmedFinanceExecutions({
    ...f.params,
    signal: controller.signal,
    resolvePending: async () => {
      controller.abort();
      return new Promise(() => {});
    },
  });
  expect(result.failures).toEqual([{ claimId: "pending", reason: "recovery_cancelled" }]);
  expect(await fs.readFile(f.journal, "utf8")).toBe(before);
});

it("recovers the original post-fill mark when the receipt was already delivered without replaying a trade", async () => {
  const f = await runConfirmed();
  await appendFinanceExecutionReceipt(f.params.ledgerDir, f.receipt);
  const before = await readFinancePositionRecords(f.params.ledgerDir);
  expect(before.receipts).toEqual([f.receipt]);
  expect(before.marks).toEqual([]);
  const first = await recoverConfirmedFinanceExecutions(f.params);
  const second = await recoverConfirmedFinanceExecutions(f.params);
  expect(first.failures).toEqual([]);
  expect(second.failures).toEqual([]);
  const after = await readFinancePositionRecords(f.params.ledgerDir);
  expect(after.receipts).toEqual([f.receipt]);
  expect(after.marks).toEqual([
    {
      instrument: f.receipt.instrument,
      price: f.receipt.fill.fillPrice,
      at: f.receipt.fill.filledAt,
    },
  ]);
});

it("keeps a newer original mark when restoring an older confirmed receipt", async () => {
  const f = await runConfirmed();
  const mark = { instrument: f.receipt.instrument, price: 123, at: new Date().toISOString() };
  await appendFinancePositionMark(f.params.ledgerDir, mark);
  const result = await recoverConfirmedFinanceExecutions(f.params);
  expect(result.failures).toEqual([]);
  const after = await readFinancePositionRecords(f.params.ledgerDir);
  expect(after.receipts).toEqual([f.receipt]);
  expect(after.marks).toEqual([mark]);
});

const validProtection = { id: "original-stop", quantity: 5, stopPrice: 90 };
it.each([
  { protectiveOrders: [{ ...validProtection, quantity: null }], positionQuantity: 5 },
  { protectiveOrders: [{ id: "original-stop", stopPrice: 90 }], positionQuantity: 5 },
  { protectiveOrders: [{ ...validProtection, quantity: false }], positionQuantity: 5 },
  { protectiveOrders: [{ ...validProtection, quantity: "5" }], positionQuantity: 5 },
  { protectiveOrders: [{ ...validProtection, quantity: 0 }], positionQuantity: 5 },
  { protectiveOrders: [{ ...validProtection, quantity: -1 }], positionQuantity: 5 },
  { protectiveOrders: [null], positionQuantity: 5 },
  { protectiveOrders: {}, positionQuantity: 5 },
  { protectiveOrders: null, positionQuantity: 5 },
  { protectiveOrders: [validProtection] },
  { protectiveOrders: [validProtection], positionQuantity: "5" },
  { protectiveOrders: [validProtection], positionQuantity: null },
  { protectiveOrders: [validProtection], positionQuantity: 4 },
  { protectiveOrders: [{ ...validProtection, id: " " }], positionQuantity: 5 },
  { protectiveOrders: [{ ...validProtection, stopPrice: null }], positionQuantity: 5 },
  { protectiveOrders: [{ ...validProtection, orderType: "market" }], positionQuantity: 5 },
  { protectiveOrders: [{ ...validProtection, limitPrice: 89 }], positionQuantity: 5 },
  { protectiveOrders: [{ ...validProtection, orderType: "stop_limit" }], positionQuantity: 5 },
  {
    protectiveOrders: [{ ...validProtection, orderType: "stop_limit", limitPrice: 91 }],
    positionQuantity: 5,
  },
  {
    protectiveOrders: [
      { ...validProtection, quantity: 2 },
      { ...validProtection, quantity: 2 },
    ],
    positionQuantity: 5,
  },
])("keeps malformed persisted protection unresolved before any resolver: %j", async (metadata) => {
  const f = await runConfirmed();
  const first = JSON.parse((await fs.readFile(f.journal, "utf8")).split("\n")[0]);
  const pending = {
    ...first,
    status: "unknown",
    binding: { ...first.binding, intent: { ...first.binding.intent, side: "sell" }, ...metadata },
  };
  const raw = JSON.stringify(pending) + "\n";
  await fs.writeFile(f.journal, raw);
  const resolvePending = vi.fn(async () => ({
    ...f.receipt.fill,
    terminalOrderIdentity: { orderId: "broker-original", terminal: true as const },
  }));
  const recovered = await recoverConfirmedFinanceExecutions({ ...f.params, resolvePending });
  expect(recovered.pendingReconciliation).toEqual([first.id]);
  expect(recovered.replayed).toEqual([]);
  expect(resolvePending).not.toHaveBeenCalled();
  expect(await fs.readFile(f.journal, "utf8")).toBe(raw);
  expect((await readFinancePositionRecords(f.params.ledgerDir)).receipts).toEqual([]);
});
it.each(
  [
    [],
    [validProtection],
    [{ ...validProtection, orderType: "stop" }],
    [{ ...validProtection, orderType: "stop_limit", limitPrice: 89 }],
    [{ ...validProtection, id: "partial-stop", quantity: 2 }],
  ].map((protectiveOrders) => ({ protectiveOrders })),
)("preserves valid persisted protection resolver bindings: %j", async ({ protectiveOrders }) => {
  const f = await runConfirmed();
  const first = JSON.parse((await fs.readFile(f.journal, "utf8")).split("\n")[0]);
  const pending = {
    ...first,
    status: "unknown",
    binding: {
      ...first.binding,
      intent: { ...first.binding.intent, side: "sell" },
      protectiveOrders,
      positionQuantity: 5,
    },
  };
  await fs.writeFile(f.journal, JSON.stringify(pending) + "\n");
  const resolvePending = vi.fn(async () => ({
    ...f.receipt.fill,
    terminalOrderIdentity: { orderId: "broker-original", terminal: true as const },
  }));
  const recovered = await recoverConfirmedFinanceExecutions({ ...f.params, resolvePending });
  expect(recovered.failures).toEqual([]);
  expect(recovered.pendingReconciliation).toEqual([]);
  expect(recovered.replayed).toHaveLength(1);
  expect(resolvePending).toHaveBeenCalledTimes(1);
});
