import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createPaperExecutionAdapter,
  placeFinanceOrder,
  type FinanceOrderPlacementRequest,
} from "./finance-execution-adapter.js";
import { recoverConfirmedFinanceExecutions } from "./finance-execution-recovery.js";
import {
  createFinanceExecutionSafetyContext,
  type FinanceExecutionSafetyContextInput,
  type FinanceExecutionSafetyFacts,
} from "./finance-execution-safety.js";
import {
  appendFinanceExecutionReceipt,
  readFinanceAccountPositionLedger,
  readFinancePositionRecords,
} from "./finance-position-ledger.js";
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
