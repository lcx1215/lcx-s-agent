import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AlpacaOrderUncertainError } from "./finance-alpaca-execution-adapter.js";
import {
  buildFinanceExecutionReceipt,
  createPaperExecutionAdapter,
  placeFinanceOrder,
  type FinanceOrderPlacementRequest,
} from "./finance-execution-adapter.js";
import { recoverConfirmedFinanceExecutions } from "./finance-execution-recovery.js";
import {
  createFinanceExecutionSafetyContext,
  financeExecutionGrossExposureIssue,
  FinanceExecutionSafetyFactsError,
  FinanceExecutionSafetyDispatchError,
  FinanceExecutionSafetyUncertainError,
  type FinanceExecutionSafetyContextInput,
  type FinanceExecutionSafetyFacts,
  readFinanceExecutionSafetyClaims,
  retireFinancePaperExecutionClaim,
  withFinanceExecutionSafety,
} from "./finance-execution-safety.js";
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

async function seedAlpacaPendingClaim(
  f: Awaited<ReturnType<typeof fixture>>,
  venue = "alpaca:paper",
) {
  const adapterId = "alpaca-venue-fixture";
  const intent = f.input.intent;
  const readFacts = async () => ({ ...f.facts, venue, adapterId });
  const input = { ...f.input, venue, adapterId, readFacts };
  await expect(
    withFinanceExecutionSafety({
      context: createFinanceExecutionSafetyContext(input),
      intent,
      budget: input.budget,
      adapterId,
      venue,
      adapterKind: "venue",
      execute: async () => {
        throw new Error("fixture submit remains unresolved");
      },
      buildReceipt: () => {
        throw new Error("fixture receipt must not be built");
      },
    }),
  ).rejects.toBeInstanceOf(FinanceExecutionSafetyUncertainError);
  const journalName = (await fs.readdir(input.stateDir)).find((name) => name.endsWith(".jsonl"))!;
  const journalPath = path.join(input.stateDir, journalName);
  const raw = await fs.readFile(journalPath, "utf8");
  const latest = JSON.parse(raw.trim().split("\n").at(-1)!);
  return { input, journalPath, raw, claim: latest as { id: string } };
}

function retirementParams(
  pending: Awaited<ReturnType<typeof seedAlpacaPendingClaim>>,
  expectedJournalHash = createHash("sha256").update(pending.raw).digest("hex"),
) {
  return {
    stateDir: pending.input.stateDir,
    accountId: pending.input.accountId,
    claimId: pending.claim.id,
    authorizationRef: "user-authorization-fixture",
    reason: "Explicitly retire one unresolved Paper claim after recorded broker observation.",
    brokerObservationRef: "sha256:" + "a".repeat(64),
    expectedJournalHash,
  };
}
it("requires genuine context for attended and internal paper; copied JSON cannot authorize", async () => {
  const f = await fixture();
  const execute = vi.fn(f.adapter.execute);
  f.request = { ...f.request, adapters: [{ ...f.adapter, execute }] };
  expect((await placeFinanceOrder(f.request)).status).toBe("refused");
  const context = createFinanceExecutionSafetyContext(f.input);
  expect(
    (await placeFinanceOrder({ ...f.request, safetyContext: JSON.parse(JSON.stringify(context)) }))
      .status,
  ).toBe("refused");
  expect(execute).not.toHaveBeenCalled();
});
it("allows a declared spot plan and durably consumes its intent once", async () => {
  const f = await fixture();
  expect(
    (
      await placeFinanceOrder({
        ...f.request,
        safetyContext: createFinanceExecutionSafetyContext(f.input),
      })
    ).status,
  ).toBe("placed");
  expect(
    (
      await placeFinanceOrder({
        ...f.request,
        safetyContext: createFinanceExecutionSafetyContext(f.input),
      })
    ).refusalReasons,
  ).toContain("execution_safety_intent_already_claimed");
  const files = await fs.readdir(f.input.stateDir);
  const journal = await fs.readFile(path.join(f.input.stateDir, files[0]), "utf8");
  expect(journal).toContain('"status":"confirmed"');
  expect(journal).toContain('"binding"');
  expect(journal).toContain('"fill"');
});
it("rechecks target-weight drift against the fresh locked position before dispatch", async () => {
  const f = await fixture();
  const intent = {
    ...f.request.intent,
    targetWeightAuthorization: {
      targetWeight: 0.1,
      driftBandFraction: 0.02,
      maxOrderNotional: 300,
    },
  };
  const freshFacts = { ...f.facts, positionQuantity: 9 };
  const context = createFinanceExecutionSafetyContext({
    ...f.input,
    intent,
    readFacts: async () => freshFacts,
  });
  const result = await placeFinanceOrder({ ...f.request, intent, safetyContext: context });
  expect(result.status).toBe("refused");
  expect(result.refusalReasons).toContain(
    "execution_safety_target_weight_drift_no_longer_authorizes_side",
  );
});
it("allows a rebalance only within the fresh drift band and controller notional cap", async () => {
  const f = await fixture();
  const intent = {
    ...f.request.intent,
    targetWeightAuthorization: {
      targetWeight: 0.1,
      driftBandFraction: 0.02,
      maxOrderNotional: 300,
    },
  };
  const context = createFinanceExecutionSafetyContext({ ...f.input, intent });
  const result = await placeFinanceOrder({ ...f.request, intent, safetyContext: context });
  expect(result.status).toBe("placed");
});
it("rejects a target-rebalance intent that exceeds its controller notional cap", async () => {
  const f = await fixture();
  const intent = {
    ...f.request.intent,
    quantity: 4,
    targetWeightAuthorization: {
      targetWeight: 0.5,
      driftBandFraction: 0.02,
      maxOrderNotional: 300,
    },
  };
  const context = createFinanceExecutionSafetyContext({
    ...f.input,
    intent,
    policy: { ...f.input.policy, authorizedQuantity: 4 },
  });
  const result = await placeFinanceOrder({ ...f.request, intent, safetyContext: context });
  expect(result.status).toBe("refused");
  expect(result.refusalReasons).toContain(
    "execution_safety_target_weight_drift_authorization_exceeded",
  );
});
it.each([
  "account",
  "currency",
  "hedged",
  "margin",
  "asset",
  "stale",
  "pending",
  "unknown",
  "cash",
  "gross",
  "limit",
])("refuses unsafe %s facts before dispatch", async (kind) => {
  const f = await fixture();
  const facts = {
    ...f.facts,
    account: { ...f.facts.account },
    quote: { ...f.facts.quote },
    instrumentEvidence: { ...f.facts.instrumentEvidence },
    openOrderIds: [...f.facts.openOrderIds],
    unresolvedOrderIds: [...f.facts.unresolvedOrderIds],
  };
  if (kind === "account") {
    facts.accountId = "other";
  }
  if (kind === "currency") {
    facts.quote.currency = "EUR";
  }
  if (kind === "hedged") {
    facts.instrumentEvidence.hedged = true;
  }
  if (kind === "margin") {
    facts.instrumentEvidence.marginEnabled = true;
  }
  if (kind === "asset") {
    Object.assign(facts.instrumentEvidence, { assetType: "option" });
  }
  if (kind === "stale") {
    facts.observedAt = "2020-01-01T00:00:00Z";
  }
  if (kind === "pending") {
    facts.openOrderIds = ["order"];
  }
  if (kind === "unknown") {
    facts.unresolvedOrderIds = ["unknown"];
  }
  if (kind === "cash") {
    facts.account.availableCash = 10;
  }
  if (kind === "gross") {
    facts.account.grossExposure = 3000;
  }
  let intent = f.request.intent;
  if (kind === "limit") {
    intent = { ...intent, orderType: "limit", limitPrice: 2000 };
    facts.account.availableCash = 1000;
  }
  const result = await placeFinanceOrder({
    ...f.request,
    intent,
    safetyContext: createFinanceExecutionSafetyContext({
      ...f.input,
      intent,
      readFacts: async () => facts,
    }),
  });
  expect(result.status).toBe("refused");
});
it("allows proven spot reduction but never crossing zero", async () => {
  const f = await fixture();
  const intent = { ...f.request.intent, side: "sell" as const };
  const input = {
    ...f.input,
    intent,
    policy: { ...f.input.policy, authorizedSide: "sell" as const },
  };
  expect(
    (
      await placeFinanceOrder({
        ...f.request,
        intent,
        safetyContext: createFinanceExecutionSafetyContext(input),
      })
    ).status,
  ).toBe("placed");
  const tooMuch = { ...intent, intentId: "too-much", quantity: 6 };
  expect(
    (
      await placeFinanceOrder({
        ...f.request,
        intent: tooMuch,
        safetyContext: createFinanceExecutionSafetyContext({
          ...input,
          intent: tooMuch,
          policy: { ...input.policy, authorizedQuantity: 6 },
        }),
      })
    ).status,
  ).toBe("refused");
});
it("keeps an Alpaca client-id lookup 404 unknown blocking and never retries automatically", async () => {
  const f = await fixture();
  const failing = {
    ...f.adapter,
    execute: async () => {
      throw new AlpacaOrderUncertainError(
        "client-order-id",
        undefined,
        new Error("client-order-id lookup returned 404"),
      );
    },
  };
  await expect(
    placeFinanceOrder({
      ...f.request,
      adapters: [failing],
      safetyContext: createFinanceExecutionSafetyContext(f.input),
    }),
  ).rejects.toBeInstanceOf(FinanceExecutionSafetyUncertainError);
  const journalFile = (await fs.readdir(f.input.stateDir)).find((name) => name.endsWith(".jsonl"))!;
  const journalPath = path.join(f.input.stateDir, journalFile);
  const legacyEntries = (await fs.readFile(journalPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  legacyEntries[legacyEntries.length - 1] = {
    ...legacyEntries.at(-1),
    status: "unknown",
    failure: {
      phase: "execute",
      disposition: "definite_rejection",
      venueResponse: { httpStatus: 422 },
    },
  };
  await fs.writeFile(
    journalPath,
    legacyEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const intent = { ...f.request.intent, intentId: "new-id" };
  expect(
    (
      await placeFinanceOrder({
        ...f.request,
        intent,
        safetyContext: createFinanceExecutionSafetyContext({ ...f.input, intent }),
      })
    ).refusalReasons,
  ).toContain("execution_safety_account_requires_reconciliation");
  const entries = (await fs.readFile(journalPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { status: string; failure?: unknown });
  expect(entries.at(-1)).toMatchObject({
    status: "unknown",
    failure: { phase: "execute", disposition: "definite_rejection" },
  });
});

it("keeps terminal claim snapshots ordered by their last durable append, even with equal timestamps", async () => {
  const f = await fixture();
  expect(
    (
      await placeFinanceOrder({
        ...f.request,
        safetyContext: createFinanceExecutionSafetyContext(f.input),
      })
    ).status,
  ).toBe("placed");
  const journalName = (await fs.readdir(f.input.stateDir)).find((name) => name.endsWith(".jsonl"))!;
  const journalPath = path.join(f.input.stateDir, journalName);
  const original = JSON.parse((await fs.readFile(journalPath, "utf8")).trim().split("\n").at(-1)!);
  const sameTime = original.at;
  const first = { ...original, id: "first-id", at: sameTime };
  const second = { ...original, id: "second-id", at: sameTime };
  await fs.writeFile(
    journalPath,
    [first, second, first].map((claim) => JSON.stringify(claim)).join("\n") + "\n",
  );
  const claims = await readFinanceExecutionSafetyClaims({
    stateDir: f.input.stateDir,
    accountId: f.input.accountId,
    venue: f.input.venue,
  });
  expect(claims.map((claim) => claim.id)).toEqual(["second-id", "first-id"]);
});

it("rejects terminal journal markers without matching typed proof or with a fill", async () => {
  const f = await fixture();
  expect(
    (
      await placeFinanceOrder({
        ...f.request,
        safetyContext: createFinanceExecutionSafetyContext(f.input),
      })
    ).status,
  ).toBe("placed");
  const journalName = (await fs.readdir(f.input.stateDir)).find((name) => name.endsWith(".jsonl"))!;
  const journalPath = path.join(f.input.stateDir, journalName);
  const confirmed = JSON.parse((await fs.readFile(journalPath, "utf8")).trim().split("\n").at(-1)!);
  const clean = { ...confirmed, status: "rejected" as const };
  delete clean.fill;
  delete clean.receipt;
  const invalidMarkers = [
    { ...clean, failure: undefined },
    { ...clean, failure: { phase: "not_started", disposition: "not_started" } },
    {
      ...clean,
      failure: {
        phase: "execute",
        disposition: "definite_rejection",
        venueResponse: { httpStatus: 422 },
      },
      fill: confirmed.fill,
    },
    {
      ...clean,
      failure: {
        phase: "execute",
        disposition: "definite_rejection",
        venueResponse: { httpStatus: 422 },
      },
      receipt: confirmed.receipt,
    },
    ...[408, 499].map((httpStatus) => ({
      ...clean,
      failure: {
        phase: "execute",
        disposition: "definite_rejection",
        venueResponse: { httpStatus },
      },
    })),
  ];
  for (const marker of invalidMarkers) {
    await fs.writeFile(journalPath, JSON.stringify(marker) + "\n");
    await expect(
      readFinanceExecutionSafetyClaims({
        stateDir: f.input.stateDir,
        accountId: f.input.accountId,
        venue: f.input.venue,
      }),
    ).rejects.toThrow("invalid execution safety journal");
  }
});

it("persists typed venue rejection as terminal and permits only a distinct later intent", async () => {
  expect(
    () =>
      new FinanceExecutionSafetyDispatchError({
        executionStage: "venue_response",
        httpStatus: 503,
      }),
  ).toThrow();
  expect(
    () => new FinanceExecutionSafetyDispatchError({ executionStage: "venue_response" }),
  ).toThrow();
  for (const httpStatus of [408, 499]) {
    expect(
      () =>
        new FinanceExecutionSafetyDispatchError({ executionStage: "venue_response", httpStatus }),
    ).toThrow();
  }
  const f = await fixture();
  const execute = vi.fn(async () => {
    throw new FinanceExecutionSafetyDispatchError({
      executionStage: "venue_response",
      httpStatus: 422,
      brokerCode: 1234,
      cause: new Error("secret broker response body"),
    });
  });
  await expect(
    placeFinanceOrder({
      ...f.request,
      adapters: [{ ...f.adapter, execute }],
      safetyContext: createFinanceExecutionSafetyContext(f.input),
    }),
  ).rejects.toMatchObject({
    status: "rejected",
    attempt: {
      phase: "execute",
      disposition: "definite_rejection",
      venueResponse: { httpStatus: 422, brokerCode: 1234 },
    },
  });
  expect(execute).toHaveBeenCalledTimes(1);
  const journal = (await fs.readdir(f.input.stateDir)).find((name) => name.endsWith(".jsonl"))!;
  const raw = await fs.readFile(path.join(f.input.stateDir, journal), "utf8");
  expect(raw).toContain('"status":"rejected"');
  expect(raw).toContain('"disposition":"definite_rejection"');
  expect(raw).toContain('"httpStatus":422');
  expect(raw).not.toContain("secret broker response body");
  const duplicate = await placeFinanceOrder({
    ...f.request,
    adapters: [{ ...f.adapter, execute: vi.fn() }],
    safetyContext: createFinanceExecutionSafetyContext(f.input),
  });
  expect(duplicate.refusalReasons).toContain("execution_safety_intent_already_claimed");
  await new Promise((resolve) => setTimeout(resolve, 3));
  const observedAt = new Date().toISOString();
  const lastClaimId = JSON.parse(raw.trim().split("\n").at(-1)!).id as string;
  const distinctIntent = {
    ...f.request.intent,
    intentId: "after-rejection",
    runAuthorizationId: "next-run-after-rejection",
    referencePriceAt: observedAt,
  };
  const next = await placeFinanceOrder({
    ...f.request,
    intent: distinctIntent,
    safetyContext: createFinanceExecutionSafetyContext({
      ...f.input,
      intent: distinctIntent,
      readFacts: async () => ({
        ...f.facts,
        snapshotId: "after-rejection",
        reconciledThroughClaimId: lastClaimId,
        observedAt,
        quote: { ...f.facts.quote, observedAt },
        instrumentEvidence: { ...f.facts.instrumentEvidence, observedAt },
      }),
    }),
  });
  expect(next).toMatchObject({ status: "placed" });
});

it("records typed pre-dispatch as terminal while retaining same-intent deduplication", async () => {
  const f = await fixture();
  const execute = vi.fn(async () => {
    throw new FinanceExecutionSafetyDispatchError({ executionStage: "pre_dispatch" });
  });
  const request = {
    ...f.request,
    adapters: [{ ...f.adapter, execute }],
    safetyContext: createFinanceExecutionSafetyContext(f.input),
  };
  await expect(placeFinanceOrder(request)).rejects.toMatchObject({
    status: "not_started",
    attempt: { phase: "not_started", disposition: "not_started" },
  });
  const retry = await placeFinanceOrder({
    ...request,
    safetyContext: createFinanceExecutionSafetyContext(f.input),
  });
  expect(retry.status).toBe("refused");
  expect(retry.refusalReasons).toContain("execution_safety_intent_already_claimed");
  expect(execute).toHaveBeenCalledTimes(1);
  await new Promise((resolve) => setTimeout(resolve, 3));
  const observedAt = new Date().toISOString();
  const journalFile = (await fs.readdir(f.input.stateDir)).find((name) => name.endsWith(".jsonl"))!;
  const lastClaimId = JSON.parse(
    (await fs.readFile(path.join(f.input.stateDir, journalFile), "utf8"))
      .trim()
      .split("\n")
      .at(-1)!,
  ).id as string;
  const distinctIntent = {
    ...f.request.intent,
    intentId: "after-predispatch",
    runAuthorizationId: "next-run-after-predispatch",
    referencePriceAt: observedAt,
  };
  const next = await placeFinanceOrder({
    ...f.request,
    intent: distinctIntent,
    safetyContext: createFinanceExecutionSafetyContext({
      ...f.input,
      intent: distinctIntent,
      readFacts: async () => ({
        ...f.facts,
        snapshotId: "after-predispatch",
        reconciledThroughClaimId: lastClaimId,
        observedAt,
        quote: { ...f.facts.quote, observedAt },
        instrumentEvidence: { ...f.facts.instrumentEvidence, observedAt },
      }),
    }),
  });
  expect(next).toMatchObject({ status: "placed" });
});

it("keeps the reservation blocking when appending a typed terminal marker fails", async () => {
  const f = await fixture();
  const execute = vi.fn(async () => {
    throw new FinanceExecutionSafetyDispatchError({
      executionStage: "venue_response",
      httpStatus: 422,
    });
  });
  const open = fs.open.bind(fs);
  let appendCalls = 0;
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (args[1] === "a" && ++appendCalls === 2) {
      throw new Error("fixture terminal append failure");
    }
    return open(...args);
  });
  try {
    await expect(
      placeFinanceOrder({
        ...f.request,
        adapters: [{ ...f.adapter, execute }],
        safetyContext: createFinanceExecutionSafetyContext(f.input),
      }),
    ).rejects.toMatchObject({
      name: "FinanceExecutionSafetyUncertainError",
      attempt: { phase: "execute", disposition: "definite_rejection" },
    });
  } finally {
    openSpy.mockRestore();
  }
  expect(appendCalls).toBe(2);
  expect(execute).toHaveBeenCalledTimes(1);
  const journalName = (await fs.readdir(f.input.stateDir)).find((name) => name.endsWith(".jsonl"))!;
  const journal = (await fs.readFile(path.join(f.input.stateDir, journalName), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { status: string });
  expect(journal.map((claim) => claim.status)).toEqual(["reserved"]);
  const intent = { ...f.request.intent, intentId: "blocked-after-marker-failure" };
  const retry = await placeFinanceOrder({
    ...f.request,
    intent,
    safetyContext: createFinanceExecutionSafetyContext({ ...f.input, intent }),
  });
  expect(retry.refusalReasons).toContain("execution_safety_account_requires_reconciliation");
  expect(execute).toHaveBeenCalledTimes(1);
});

it("retires only one explicitly authorized Paper unknown claim while preserving dedup and recovery semantics", async () => {
  const f = await fixture();
  const pending = await seedAlpacaPendingClaim(f);
  const args = retirementParams(pending);
  const retired = await retireFinancePaperExecutionClaim(args);
  expect(retired).toMatchObject({ retired: true, alreadyRetired: false });

  const claims = await readFinanceExecutionSafetyClaims({
    stateDir: args.stateDir,
    accountId: args.accountId,
    venue: "alpaca:paper",
  });
  expect(claims.at(-1)).toMatchObject({
    id: args.claimId,
    status: "operator_retired",
    notional: 100,
    operatorRetirement: {
      authorizedBy: "user",
      originalStatus: "unknown",
      authorizationRef: args.authorizationRef,
      brokerObservationRef: args.brokerObservationRef,
    },
  });
  expect(claims.at(-1)?.fill).toBeUndefined();
  expect(claims.at(-1)?.receipt).toBeUndefined();

  const recovery = await recoverConfirmedFinanceExecutions({
    safetyStateDir: args.stateDir,
    accountId: args.accountId,
    venue: "alpaca:paper",
    ledgerDir: path.join(args.stateDir, "ledger"),
    resolvePending: vi.fn(async () => undefined),
  });
  expect(recovery).toMatchObject({ replayed: [], pendingReconciliation: [], noFill: [] });
  expect(recovery.failures).toEqual([]);

  const sameIntent = await placeFinanceOrder({
    ...f.request,
    executionAdapterId: "alpaca-venue-fixture",
    adapters: [
      { ...f.adapter, id: "alpaca-venue-fixture", venue: "alpaca:paper", execute: vi.fn() },
    ],
    safetyContext: createFinanceExecutionSafetyContext({
      ...f.input,
      venue: "alpaca:paper",
      adapterId: "alpaca-venue-fixture",
      readFacts: async () => ({
        ...f.facts,
        venue: "alpaca:paper",
        adapterId: "alpaca-venue-fixture",
      }),
    }),
  });
  expect(sameIntent.refusalReasons).toContain("execution_safety_intent_already_claimed");
  expect(sameIntent.status).toBe("refused");

  await new Promise((resolve) => setTimeout(resolve, 3));
  const observedAt = new Date().toISOString();
  const newIntent = {
    ...f.input.intent,
    intentId: "after-operator-retirement",
    runAuthorizationId: "next-run-after-retirement",
    referencePriceAt: observedAt,
  };
  const execute = vi.fn(async () => ({
    filledQuantity: 1,
    fillPrice: 100,
    filledAt: observedAt,
    venueRef: "alpaca:paper:new-paper-order",
    terminalOrderIdentity: { orderId: "new-paper-order", terminal: true as const },
  }));
  const next = await placeFinanceOrder({
    ...f.request,
    intent: newIntent,
    executionAdapterId: "alpaca-venue-fixture",
    adapters: [{ ...f.adapter, id: "alpaca-venue-fixture", venue: "alpaca:paper", execute }],
    safetyContext: createFinanceExecutionSafetyContext({
      ...f.input,
      intent: newIntent,
      venue: "alpaca:paper",
      adapterId: "alpaca-venue-fixture",
      readFacts: async () => ({
        ...f.facts,
        venue: "alpaca:paper",
        adapterId: "alpaca-venue-fixture",
        snapshotId: "after-operator-retirement",
        reconciledThroughClaimId: args.claimId,
        observedAt,
        quote: { ...f.facts.quote, observedAt },
        instrumentEvidence: { ...f.facts.instrumentEvidence, observedAt },
      }),
    }),
  });
  expect(next.status).toBe("placed");
  expect(execute).toHaveBeenCalledTimes(1);
});

it("keeps retirement append-only, idempotent, CAS-protected, and fail-closed", async () => {
  const f = await fixture();
  const pending = await seedAlpacaPendingClaim(f);
  const args = retirementParams(pending);
  const first = await retireFinancePaperExecutionClaim(args);
  const afterFirst = await fs.readFile(pending.journalPath, "utf8");
  const repeated = await retireFinancePaperExecutionClaim({
    ...args,
    expectedJournalHash: first.journalHash,
  });
  expect(repeated.alreadyRetired).toBe(true);
  expect(await fs.readFile(pending.journalPath, "utf8")).toBe(afterFirst);
  await expect(retireFinancePaperExecutionClaim(args)).rejects.toThrow(
    "Paper execution retirement journal conflict",
  );

  const f2 = await fixture();
  const pending2 = await seedAlpacaPendingClaim(f2);
  const args2 = retirementParams(pending2);
  const open = fs.open.bind(fs);
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...params) => {
    if (params[1] === "a") {
      throw new Error("fixture retirement append failure");
    }
    return open(...params);
  });
  try {
    await expect(retireFinancePaperExecutionClaim(args2)).rejects.toThrow(
      "fixture retirement append failure",
    );
  } finally {
    openSpy.mockRestore();
  }
  const unchanged = await readFinanceExecutionSafetyClaims({
    stateDir: args2.stateDir,
    accountId: args2.accountId,
    venue: "alpaca:paper",
  });
  expect(unchanged.at(-1)).toMatchObject({ id: args2.claimId, status: "unknown" });
  const stillBlocked = await placeFinanceOrder({
    ...f2.request,
    executionAdapterId: "alpaca-venue-fixture",
    adapters: [{ ...f2.adapter, id: "alpaca-venue-fixture", venue: "alpaca:paper" }],
    intent: { ...f2.request.intent, intentId: "after-failed-retirement" },
    safetyContext: createFinanceExecutionSafetyContext({
      ...f2.input,
      intent: { ...f2.request.intent, intentId: "after-failed-retirement" },
      venue: "alpaca:paper",
      adapterId: "alpaca-venue-fixture",
      readFacts: async () => ({
        ...f2.facts,
        venue: "alpaca:paper",
        adapterId: "alpaca-venue-fixture",
      }),
    }),
  });
  expect(stillBlocked.refusalReasons).toContain("execution_safety_account_requires_reconciliation");
});

it("refuses to retire live, confirmed, unbound, or malformed Paper claims", async () => {
  const f = await fixture();
  const live = await seedAlpacaPendingClaim(f, "alpaca:live");
  await expect(retireFinancePaperExecutionClaim(retirementParams(live))).rejects.toThrow(
    "Paper execution retirement claim not found",
  );

  const confirmedFixture = await fixture();
  const confirmedInput = {
    ...confirmedFixture.input,
    venue: "alpaca:paper",
    adapterId: "alpaca-venue-fixture",
    readFacts: async () => ({
      ...confirmedFixture.facts,
      venue: "alpaca:paper",
      adapterId: "alpaca-venue-fixture",
    }),
  };
  await withFinanceExecutionSafety({
    context: createFinanceExecutionSafetyContext(confirmedInput),
    intent: confirmedInput.intent,
    budget: confirmedInput.budget,
    adapterId: confirmedInput.adapterId,
    venue: confirmedInput.venue,
    adapterKind: "venue",
    execute: async () => ({
      filledQuantity: 1,
      fillPrice: 100,
      filledAt: new Date().toISOString(),
      venueRef: "alpaca:paper:confirmed-fixture",
      terminalOrderIdentity: { orderId: "confirmed-fixture", terminal: true },
    }),
    buildReceipt: (fill) =>
      buildFinanceExecutionReceipt({
        intent: confirmedInput.intent,
        adapter: { id: confirmedInput.adapterId, venue: confirmedInput.venue, kind: "venue" },
        fill,
        recordedAt: new Date().toISOString(),
        accountId: confirmedInput.accountId,
        identityVersion: "account-v1",
      }),
  });
  const confirmedFile = (await fs.readdir(confirmedInput.stateDir)).find((name) =>
    name.endsWith(".jsonl"),
  )!;
  const confirmedRaw = await fs.readFile(path.join(confirmedInput.stateDir, confirmedFile), "utf8");
  const confirmedRow = JSON.parse(confirmedRaw.trim().split("\n").at(-1)!) as {
    id: string;
  };
  await expect(
    retireFinancePaperExecutionClaim({
      ...retirementParams({
        input: confirmedInput,
        journalPath: path.join(confirmedInput.stateDir, confirmedFile),
        raw: confirmedRaw,
        claim: confirmedRow,
      }),
      claimId: confirmedRow.id,
    }),
  ).rejects.toThrow("Paper execution retirement claim is not eligible");

  const paper = await seedAlpacaPendingClaim(await fixture());
  const paperArgs = retirementParams(paper);
  const raw = await fs.readFile(paper.journalPath, "utf8");
  const lines = raw.trim().split("\n");
  const row = JSON.parse(lines.at(-1)!);
  row.status = "operator_retired";
  row.operatorRetirement = {
    authorizedBy: "user",
    authorizationRef: "fixture",
    reason: "fixture",
    brokerObservationRef: "bad-ref",
    retiredAt: new Date().toISOString(),
    originalStatus: "unknown",
  };
  lines[lines.length - 1] = JSON.stringify(row);
  await fs.writeFile(paper.journalPath, `${lines.join("\n")}\n`);
  const mutated = await fs.readFile(paper.journalPath, "utf8");
  const malformedArgs = retirementParams(
    { ...paper, raw: mutated },
    createHash("sha256").update(mutated).digest("hex"),
  );
  await expect(retireFinancePaperExecutionClaim(malformedArgs)).rejects.toThrow(
    "invalid execution safety journal",
  );
  await expect(
    retireFinancePaperExecutionClaim({ ...paperArgs, brokerObservationRef: "not-a-hash" }),
  ).rejects.toThrow("invalid Paper execution retirement proof");
});

it("refuses legacy pending rows with adapterKind before appending an operator retirement marker", async () => {
  const f = await fixture();
  const pending = await seedAlpacaPendingClaim(f);
  const rows = pending.raw.trim().split("\n");
  const claim = JSON.parse(rows.at(-1)!);
  claim.adapterKind = "venue";
  rows[rows.length - 1] = JSON.stringify(claim);
  const rawWithAdapterKind = `${rows.join("\n")}\n`;
  await fs.writeFile(pending.journalPath, rawWithAdapterKind);

  const parsed = await readFinanceExecutionSafetyClaims({
    stateDir: pending.input.stateDir,
    accountId: pending.input.accountId,
    venue: "alpaca:paper",
  });
  expect(parsed.at(-1)).toMatchObject({
    id: pending.claim.id,
    status: "unknown",
    adapterKind: "venue",
  });

  await expect(
    retireFinancePaperExecutionClaim(
      retirementParams(
        { ...pending, raw: rawWithAdapterKind },
        createHash("sha256").update(rawWithAdapterKind).digest("hex"),
      ),
    ),
  ).rejects.toThrow("Paper execution retirement claim is not eligible");
  expect(await fs.readFile(pending.journalPath, "utf8")).toBe(rawWithAdapterKind);
  expect(
    (
      await readFinanceExecutionSafetyClaims({
        stateDir: pending.input.stateDir,
        accountId: pending.input.accountId,
        venue: "alpaca:paper",
      })
    ).at(-1),
  ).toMatchObject({ id: pending.claim.id, status: "unknown", adapterKind: "venue" });
});

it.each(["ordinary", "dispatch_shaped", "pre_dispatch_shaped"] as const)(
  "keeps a receipt-stage error unresolved even if its type claims rejection (%s)",
  async (errorKind) => {
    const f = await fixture();
    await expect(
      withFinanceExecutionSafety({
        context: createFinanceExecutionSafetyContext(f.input),
        intent: f.input.intent,
        budget: f.input.budget,
        adapterId: f.input.adapterId,
        venue: f.input.venue,
        adapterKind: "paper",
        execute: (signal) => f.adapter.execute(f.input.intent, signal),
        buildReceipt: () => {
          throw errorKind === "dispatch_shaped"
            ? new FinanceExecutionSafetyDispatchError({
                executionStage: "venue_response",
                httpStatus: 422,
              })
            : errorKind === "pre_dispatch_shaped"
              ? new FinanceExecutionSafetyDispatchError({ executionStage: "pre_dispatch" })
              : new Error("secret receipt detail");
        },
      }),
    ).rejects.toMatchObject({ attempt: { phase: "receipt", disposition: "outcome_unresolved" } });
    const journal = (await fs.readdir(f.input.stateDir)).find((name) => name.endsWith(".jsonl"))!;
    const raw = await fs.readFile(path.join(f.input.stateDir, journal), "utf8");
    expect(raw).toContain('"phase":"receipt"');
    expect(raw).not.toContain("definite_rejection");
    expect(raw).not.toContain("secret receipt detail");
  },
);

it("serializes different issuers, cancels queued calls promptly, and never reuses stale position facts", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const wait = new Promise<void>((r) => {
    release = r;
  });
  let active = 0;
  let max = 0;
  const adapter = {
    ...f.adapter,
    execute: async (intent: typeof f.request.intent, signal: AbortSignal) => {
      active++;
      max = Math.max(max, active);
      entered();
      await wait;
      active--;
      return f.adapter.execute(intent, signal);
    },
  };
  const first = placeFinanceOrder({
    ...f.request,
    adapters: [adapter],
    safetyContext: createFinanceExecutionSafetyContext(f.input),
  });
  await started;
  const controller = new AbortController();
  const secondIntent = { ...f.request.intent, intentId: "two" };
  const second = placeFinanceOrder({
    ...f.request,
    intent: secondIntent,
    signal: controller.signal,
    adapters: [adapter],
    safetyContext: createFinanceExecutionSafetyContext({ ...f.input, intent: secondIntent }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  expect((await second).status).toBe("refused");
  const thirdIntent = { ...f.request.intent, intentId: "three" };
  const third = placeFinanceOrder({
    ...f.request,
    intent: thirdIntent,
    adapters: [adapter],
    safetyContext: createFinanceExecutionSafetyContext({ ...f.input, intent: thirdIntent }),
  });
  release();
  expect((await first).status).toBe("placed");
  expect((await third).refusalReasons).toContain("execution_safety_snapshot_precedes_last_claim");
  expect(max).toBe(1);
});
it("snapshots caller intent before facts await so mutations cannot alter the submitted order", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const input = {
    ...f.input,
    readFacts: async () => {
      entered();
      await wait;
      return f.facts;
    },
  };
  const context = createFinanceExecutionSafetyContext(input);
  const promise = placeFinanceOrder({ ...f.request, safetyContext: context });
  await started;
  Object.assign(f.request.intent, { quantity: 9000 });
  release();
  const result = await promise;
  expect(result.receipt?.quantity).toBe(1);
});

it("refuses splitting one account across safety roots", async () => {
  const f = await fixture();
  await placeFinanceOrder({
    ...f.request,
    safetyContext: createFinanceExecutionSafetyContext(f.input),
  });
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "finance-safety-other-"));
  directories.push(other);
  const result = await placeFinanceOrder({
    ...f.request,
    safetyContext: createFinanceExecutionSafetyContext({ ...f.input, stateDir: other }),
  });
  expect(result.refusalReasons).toContain("execution_safety_account_root_conflict");
});
it("includes existing holdings in instrument limits even in a new run", async () => {
  const f = await fixture();
  const budget = { ...f.request.budget, maxInstrumentNotional: 550 };
  expect(
    (
      await placeFinanceOrder({
        ...f.request,
        budget,
        safetyContext: createFinanceExecutionSafetyContext({ ...f.input, budget }),
      })
    ).refusalReasons,
  ).toContain("execution_safety_durable_budget_exceeded");
});
it("binds actual adapter identity and execute reference before an await", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const adapter = { ...f.adapter };
  const original = adapter.execute;
  const pending = placeFinanceOrder({
    ...f.request,
    adapters: [adapter],
    safetyContext: createFinanceExecutionSafetyContext({
      ...f.input,
      readFacts: async () => {
        entered();
        await wait;
        return f.facts;
      },
    }),
  });
  await started;
  adapter.id = "swapped";
  adapter.venue = "swapped";
  adapter.execute = async () => {
    throw new Error("mutated");
  };
  release();
  const result = await pending;
  expect(result.status).toBe("placed");
  expect(result.receipt?.adapterId).toBe(f.adapter.id);
  expect(result.receipt?.venue).toBe(f.adapter.venue);
  expect(original).not.toBe(adapter.execute);
});
it("bounds an uncooperative facts reader and forwards cancellation", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let observed: AbortSignal | undefined;
  const pending = placeFinanceOrder({
    ...f.request,
    signal: controller.signal,
    safetyContext: createFinanceExecutionSafetyContext({
      ...f.input,
      readFacts: async (signal) => {
        observed = signal;
        entered();
        return new Promise(() => {});
      },
    }),
  });
  await started;
  controller.abort();
  expect((await pending).status).toBe("refused");
  expect(observed?.aborted).toBe(true);
});

it.each(["account-expiry", "quote-expiry", "account-age", "quote-age", "instrument-age"])(
  "does not dispatch when %s elapses during durable reservation sync",
  async (kind) => {
    const f = await fixture();
    const initial = Date.now();
    const shortExpiry = new Date(initial + 1000).toISOString();
    const facts = {
      ...f.facts,
      expiresAt: kind === "account-expiry" ? shortExpiry : f.facts.expiresAt,
      quote: {
        ...f.facts.quote,
        expiresAt: kind === "quote-expiry" ? shortExpiry : f.facts.quote.expiresAt,
      },
    };
    const policy = { ...f.input.policy };
    if (kind === "account-age") {
      policy.maxAccountAgeMs = 1000;
    }
    if (kind === "quote-age") {
      policy.maxQuoteAgeMs = 1000;
    }
    if (kind === "instrument-age") {
      policy.maxInstrumentEvidenceAgeMs = 1000;
    }
    const execute = vi.fn(f.adapter.execute);
    const open = fs.open.bind(fs);
    const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[1] === "a") {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          await sync();
          clock.mockReturnValue(initial + 2000);
        });
      }
      return handle;
    });
    try {
      await expect(
        placeFinanceOrder({
          ...f.request,
          adapters: [{ ...f.adapter, execute }],
          safetyContext: createFinanceExecutionSafetyContext({
            ...f.input,
            policy,
            readFacts: async () => facts,
          }),
        }),
      ).rejects.toMatchObject({ status: "not_started" });
      expect(execute).not.toHaveBeenCalled();
      const journal = (await fs.readdir(f.input.stateDir)).find((name) => name.endsWith(".jsonl"))!;
      const entries = (await fs.readFile(path.join(f.input.stateDir, journal), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { status: string });
      expect(entries.map((entry) => entry.status)).toEqual(["reserved", "not_started"]);
      expect(entries.at(-1)).toMatchObject({
        failure: { phase: "not_started", disposition: "not_started" },
      });
    } finally {
      openSpy.mockRestore();
      clock.mockRestore();
    }
    if (kind === "account-expiry") {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const observedAt = new Date().toISOString();
      const journalName = (await fs.readdir(f.input.stateDir)).find((name) =>
        name.endsWith(".jsonl"),
      )!;
      const lastClaimId = JSON.parse(
        (await fs.readFile(path.join(f.input.stateDir, journalName), "utf8"))
          .trim()
          .split("\n")
          .at(-1)!,
      ).id as string;
      const intent = {
        ...f.request.intent,
        intentId: "fresh-after-facts-refusal",
        referencePriceAt: observedAt,
      };
      const next = await placeFinanceOrder({
        ...f.request,
        intent,
        safetyContext: createFinanceExecutionSafetyContext({
          ...f.input,
          intent,
          readFacts: async () => ({
            ...f.facts,
            snapshotId: "fresh-after-facts-refusal",
            reconciledThroughClaimId: lastClaimId,
            observedAt,
            quote: { ...f.facts.quote, observedAt },
            instrumentEvidence: { ...f.facts.instrumentEvidence, observedAt },
          }),
        }),
      });
      expect(next.status).toBe("placed");
    }
  },
);

it.each([0, 4, 5])(
  "does not sell inventory reserved by a protective stop: %s",
  async (reserved) => {
    const f = await fixture();
    const intent = { ...f.input.intent, side: "sell" as const, quantity: 2 };
    const input = {
      ...f.input,
      intent,
      policy: { ...f.input.policy, authorizedSide: "sell" as const },
      readFacts: async () => ({ ...f.facts, reservedSellQuantity: reserved }),
    };
    const result = await placeFinanceOrder({
      ...f.request,
      intent,
      safetyContext: createFinanceExecutionSafetyContext(input),
    });
    expect(result.status).toBe(reserved > 3 ? "refused" : "placed");
  },
);

it("passes a protected reduction plan only to its declared capable paper venue and journals it", async () => {
  const f = await fixture();
  const intent = { ...f.input.intent, side: "sell" as const, quantity: 2 };
  const protection = [
    {
      id: "old-stop-limit",
      quantity: 5,
      stopPrice: 90,
      orderType: "stop_limit" as const,
      limitPrice: 89,
    },
  ];
  const execute = vi.fn(async () => ({
    filledQuantity: 2,
    fillPrice: 100,
    filledAt: new Date().toISOString(),
    venueRef: "alpaca:paper:sale",
    terminalOrderIdentity: { orderId: "sale", terminal: true as const },
  }));
  const adapter = {
    ...f.adapter,
    kind: "venue" as const,
    venue: "alpaca:paper",
    supportsProtectedReduction: true,
    execute,
  };
  const input = {
    ...f.input,
    venue: adapter.venue,
    intent,
    policy: { ...f.input.policy, authorizedSide: "sell" as const },
    readFacts: async () => ({
      ...f.facts,
      venue: adapter.venue,
      reservedSellQuantity: 5,
      protectiveOrders: protection,
    }),
  };
  const result = await placeFinanceOrder({
    ...f.request,
    adapters: [adapter],
    intent,
    safetyContext: createFinanceExecutionSafetyContext(input),
  });
  expect(result.status).toBe("placed");
  expect(execute).toHaveBeenCalledWith(
    intent,
    expect.any(AbortSignal),
    expect.objectContaining({ protectiveOrders: protection }),
  );
  const { readFinanceExecutionSafetyClaims } = await import("./finance-execution-safety.js");
  const claims = await readFinanceExecutionSafetyClaims({
    stateDir: input.stateDir,
    accountId: input.accountId,
    venue: adapter.venue,
  });
  expect(claims[0].binding?.protectiveOrders).toEqual(protection);
});

it.each(["cash", "exposure", "drawdown", "quarantine", "missing_policy", "missing_scope"])(
  "enforces %s in the shared exit when historical differences are isolated",
  async (scenario) => {
    const f = await fixture();
    const execute = vi.fn(f.adapter.execute);
    const reconciliation = {
      status: "restricted" as const,
      historyStatus: "unresolved" as const,
      quarantinedInstruments: scenario === "quarantine" ? ["SPY"] : ["BTC/USD"],
      uncertaintyReserve: 2,
      reasons: ["synthetic"],
    };
    const account = {
      ...f.facts.account,
      ...(scenario === "cash" ? { availableCash: 101 } : {}),
      ...(scenario === "drawdown" ? { equity: 8001 } : {}),
    };
    const input = {
      ...f.input,
      policy: {
        ...f.input.policy,
        maxGrossExposure: scenario === "exposure" ? 601 : f.input.policy.maxGrossExposure,
        quantityDifferenceIsolation:
          scenario === "missing_policy"
            ? undefined
            : { instruments: ["SPY", "BTC/USD"], maxUnexplainedNotional: 10 },
      },
      readFacts: async () => ({
        ...f.facts,
        account,
        reconciliation: scenario === "missing_scope" ? undefined : reconciliation,
      }),
    };
    const result = await placeFinanceOrder({
      ...f.request,
      adapters: [{ ...f.adapter, execute }],
      safetyContext: createFinanceExecutionSafetyContext(input),
    });
    expect(result.status).toBe("refused");
    expect(execute).not.toHaveBeenCalled();
  },
);

it("persists the actual restricted scope without changing native cash or equity facts", async () => {
  const f = await fixture();
  const reconciliation = {
    status: "restricted" as const,
    historyStatus: "unresolved" as const,
    quarantinedInstruments: ["BTC/USD"],
    uncertaintyReserve: 2,
    reasons: ["synthetic"],
  };
  const execute = vi.fn(f.adapter.execute);
  const input = {
    ...f.input,
    policy: {
      ...f.input.policy,
      quantityDifferenceIsolation: { instruments: ["BTC/USD"], maxUnexplainedNotional: 10 },
    },
    readFacts: async () => ({ ...f.facts, reconciliation }),
  };
  expect(
    (
      await placeFinanceOrder({
        ...f.request,
        adapters: [{ ...f.adapter, execute }],
        safetyContext: createFinanceExecutionSafetyContext(input),
      })
    ).status,
  ).toBe("placed");
  expect(execute).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(AbortSignal),
    expect.objectContaining({ account: f.facts.account, reconciliation }),
  );
  const { readFinanceExecutionSafetyClaims } = await import("./finance-execution-safety.js");
  const claims = await readFinanceExecutionSafetyClaims({
    stateDir: f.input.stateDir,
    accountId: f.input.accountId,
    venue: f.input.venue,
  });
  expect(claims[0].binding?.reconciliation).toEqual(reconciliation);
});

it("persists classified controller failures without dispatching or leaking exception text", async () => {
  const f = await fixture();
  const { FinanceExecutionSafetyFactsError } = await import("./finance-execution-safety.js");
  const execute = vi.fn(f.adapter.execute);
  for (const [error, expected, failure] of [
    [
      new FinanceExecutionSafetyFactsError("cash_changed"),
      "execution_safety_cash_changed",
      { stage: "facts", category: "cash_changed", operation: "read_account_safety_facts" },
    ],
    [
      new FinanceExecutionSafetyFactsError("account_snapshot_unavailable", {
        reason: "alpaca_safety_quote_expired",
        stage: "quote_binding",
      }),
      "execution_safety_account_snapshot_unavailable:alpaca_safety_quote_expired:quote_binding",
      {
        stage: "facts",
        category: "account_snapshot_unavailable",
        operation: "read_account_safety_facts",
        provider: { reason: "alpaca_safety_quote_expired", stage: "quote_binding" },
      },
    ],
    [
      new Error("secret token must not be stored"),
      "execution_safety_facts_unavailable",
      { stage: "facts", category: "unexpected", operation: "read_account_safety_facts" },
    ],
  ] as const) {
    const result = await placeFinanceOrder({
      ...f.request,
      adapters: [{ ...f.adapter, execute }],
      safetyContext: createFinanceExecutionSafetyContext({
        ...f.input,
        readFacts: async () => {
          throw error;
        },
      }),
    });
    expect(result.status).toBe("refused");
    expect(result.refusalReasons).toContain(expected);
    expect(result.safetyFailure).toEqual(failure);
    expect(JSON.stringify(result)).not.toContain("secret token");
  }
  expect(execute).not.toHaveBeenCalled();
});

it("classifies state-root failures without storing raw filesystem errors", async () => {
  const f = await fixture();
  const blockedStateDir = `${f.input.stateDir}-file`;
  await fs.writeFile(blockedStateDir, "not a directory");
  directories.push(blockedStateDir);
  const result = await placeFinanceOrder({
    ...f.request,
    safetyContext: createFinanceExecutionSafetyContext({
      ...f.input,
      stateDir: blockedStateDir,
    }),
  });

  expect(result.status).toBe("refused");
  expect(result.refusalReasons).toContain("execution_safety_state_unavailable");
  expect(result.safetyFailure).toEqual({
    stage: "state",
    category: "unexpected",
    operation: "create_state_directory",
  });
  expect(JSON.stringify(result)).not.toMatch(/EEXIST|not a directory|blockedStateDir/u);
});

it("rejects unsafe runtime safety-failure classifications", () => {
  expect(
    () =>
      new FinanceExecutionSafetyFactsError("cash_changed", {
        reason: "secret" as never,
      }),
  ).toThrow("invalid finance execution safety failure classification");

  const withUnknownFields = new FinanceExecutionSafetyFactsError("cash_changed", {
    reason: "alpaca_safety_facts_inconsistent",
    stage: "account_arithmetic",
    extra: "secret provider detail",
  } as never);
  expect(withUnknownFields.provider).toEqual({
    reason: "alpaca_safety_facts_inconsistent",
    stage: "account_arithmetic",
  });
  expect(JSON.stringify(withUnknownFields.provider)).not.toContain("secret provider detail");
});

it.each([
  { gross: 500, notional: 500, reserve: 0, limit: 1000, reducing: false, issue: null },
  {
    gross: 500,
    notional: 500,
    reserve: 1,
    limit: 1000,
    reducing: false,
    issue: "execution_safety_portfolio_exposure_exceeded",
  },
  { gross: 1100, notional: 100, reserve: 0, limit: 1000, reducing: true, issue: null },
  { gross: 0, notional: 0, reserve: 0, limit: 1000, reducing: false, issue: null },
  {
    gross: -1,
    notional: 100,
    reserve: 0,
    limit: 1000,
    reducing: false,
    issue: "execution_safety_portfolio_exposure_required",
  },
  {
    gross: Number.NaN,
    notional: 100,
    reserve: 0,
    limit: 1000,
    reducing: true,
    issue: "execution_safety_portfolio_exposure_required",
  },
  {
    gross: 0,
    notional: 100,
    reserve: 0,
    limit: 0,
    reducing: true,
    issue: "execution_safety_portfolio_exposure_required",
  },
])(
  "preserves canonical gross-capacity boundaries (%j)",
  ({ gross, notional, reserve, limit, reducing, issue }) => {
    expect(
      financeExecutionGrossExposureIssue({
        grossExposure: gross,
        maxGrossExposure: limit,
        notional,
        uncertaintyReserve: reserve,
        reducing,
      }),
    ).toBe(issue);
  },
);

it("persists protected reduction observations without retiring uncertainty or copying raw errors", async () => {
  const { FinanceProtectedReductionError } = await import("./finance-protection-coordination.js");
  const f = await fixture();
  const diagnostic = {
    stage: "verify_position" as const,
    cancellationConfirmed: true,
    sellExecutionEntered: false,
    protectionRestored: false,
  };
  const execute = vi.fn(async () => {
    throw new FinanceProtectedReductionError(
      "private transport detail",
      new Error("private credential detail"),
      diagnostic,
    );
  });
  const failing = { ...f.adapter, execute };
  await expect(
    placeFinanceOrder({
      ...f.request,
      adapters: [failing],
      safetyContext: createFinanceExecutionSafetyContext(f.input),
    }),
  ).rejects.toMatchObject({
    attempt: {
      phase: "execute",
      disposition: "outcome_unresolved",
      protectedReduction: diagnostic,
    },
  });
  const claims = await readFinanceExecutionSafetyClaims({
    stateDir: f.input.stateDir,
    accountId: f.input.accountId,
    venue: f.input.venue,
  });
  expect(claims.at(-1)).toMatchObject({
    status: "unknown",
    failure: { protectedReduction: diagnostic },
  });
  expect(JSON.stringify(claims)).not.toContain("private");
  const retried = await placeFinanceOrder({
    ...f.request,
    adapters: [failing],
    safetyContext: createFinanceExecutionSafetyContext(f.input),
  });
  expect(retried.status).toBe("refused");
  expect(execute).toHaveBeenCalledTimes(1);
});
