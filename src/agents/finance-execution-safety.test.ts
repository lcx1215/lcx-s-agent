import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createPaperExecutionAdapter,
  placeFinanceOrder,
  type FinanceOrderPlacementRequest,
} from "./finance-execution-adapter.js";
import {
  createFinanceExecutionSafetyContext,
  FinanceExecutionSafetyUncertainError,
  type FinanceExecutionSafetyContextInput,
  type FinanceExecutionSafetyFacts,
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
it("retains unknown submission across a fresh issuer and never retries automatically", async () => {
  const f = await fixture();
  const failing = {
    ...f.adapter,
    execute: async () => {
      throw new Error("lost response");
    },
  };
  await expect(
    placeFinanceOrder({
      ...f.request,
      adapters: [failing],
      safetyContext: createFinanceExecutionSafetyContext(f.input),
    }),
  ).rejects.toBeInstanceOf(FinanceExecutionSafetyUncertainError);
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
});
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
      ).rejects.toBeInstanceOf(FinanceExecutionSafetyUncertainError);
      expect(execute).not.toHaveBeenCalled();
      const journal = (await fs.readdir(f.input.stateDir)).find((name) => name.endsWith(".jsonl"))!;
      const entries = (await fs.readFile(path.join(f.input.stateDir, journal), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { status: string });
      expect(entries.map((entry) => entry.status)).toEqual(["reserved", "unknown"]);
    } finally {
      openSpy.mockRestore();
      clock.mockRestore();
    }
  },
);
