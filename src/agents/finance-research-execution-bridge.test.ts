import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as alpacaRun from "./finance-alpaca-run.js";
import * as credentialEnv from "./finance-credential-env.js";
import * as executionRecovery from "./finance-execution-recovery.js";
import {
  readFinanceExecutionSafetyClaims,
  type FinanceExecutionSafetyClaim,
} from "./finance-execution-safety.js";
import {
  matchesFinanceResearchRecoveryProtection,
  recoverFinanceResearchHistory,
  runFinanceResearchExecutionBridge,
} from "./finance-research-execution-bridge.js";
import * as writeTransport from "./finance-write-transport.js";

const stopLimitProtection = {
  id: "protection-1",
  quantity: 0.5,
  stopPrice: 90,
  orderType: "stop_limit" as const,
  limitPrice: 89,
};
const stopLimitOrder = {
  id: "protection-1",
  symbol: "BTC/USD",
  side: "sell",
  type: "stop_limit",
  time_in_force: "gtc",
  qty: "0.5",
  stop_price: "90",
  limit_price: "89",
  status: "canceled",
  filled_qty: "0",
};

it("matches a stop-limit recovery record only to its exact canceled broker order", () => {
  expect(
    matchesFinanceResearchRecoveryProtection({
      instrument: "BTC/USD",
      protection: stopLimitProtection,
      brokerOrder: stopLimitOrder,
    }),
  ).toBe(true);
});

it.each([
  { type: "stop" },
  { limit_price: "88" },
  { limit_price: undefined },
  { stop_price: "91" },
  { time_in_force: "day" },
  { filled_qty: "0.1" },
])("rejects recovery when stop-limit broker identity drifts: %j", (patch) => {
  expect(
    matchesFinanceResearchRecoveryProtection({
      instrument: "BTC/USD",
      protection: stopLimitProtection,
      brokerOrder: { ...stopLimitOrder, ...patch },
    }),
  ).toBe(false);
});

it("rejects unsupported persisted protection types at recovery time", () => {
  const invalidProtection = {
    ...stopLimitProtection,
    orderType: "trailing_stop" as never,
  };
  expect(
    matchesFinanceResearchRecoveryProtection({
      instrument: "BTC/USD",
      protection: invalidProtection,
      brokerOrder: stopLimitOrder,
    }),
  ).toBe(false);
});

it("does not treat legacy stop-only records as stop-limit authorization", () => {
  expect(
    matchesFinanceResearchRecoveryProtection({
      instrument: "BTC/USD",
      protection: { id: "protection-1", quantity: 0.5, stopPrice: 90 },
      brokerOrder: stopLimitOrder,
    }),
  ).toBe(false);
});

it("rejects coerced non-numeric broker limit prices", () => {
  expect(
    matchesFinanceResearchRecoveryProtection({
      instrument: "BTC/USD",
      protection: { ...stopLimitProtection, limitPrice: 1 },
      brokerOrder: { ...stopLimitOrder, limit_price: true },
    }),
  ).toBe(false);
});

it("keeps legacy stop records compatible with exact stop orders", () => {
  expect(
    matchesFinanceResearchRecoveryProtection({
      instrument: "AAPL",
      protection: { id: "old-stop", quantity: 1, stopPrice: 90 },
      brokerOrder: {
        id: "old-stop",
        symbol: "AAPL",
        side: "sell",
        type: "stop",
        time_in_force: "gtc",
        qty: "1",
        stop_price: "90",
        status: "canceled",
        filled_qty: "0",
      },
    }),
  ).toBe(true);
});

it.each([{ qty: true }, { stop_price: true }, { filled_qty: false }])(
  "rejects coercible malformed broker numeric fields during recovery: %j",
  (patch) => {
    expect(
      matchesFinanceResearchRecoveryProtection({
        instrument: "BTC/USD",
        protection: { ...stopLimitProtection, quantity: 1, stopPrice: 1, limitPrice: 1 },
        brokerOrder: { ...stopLimitOrder, qty: "1", stop_price: "1", limit_price: "1", ...patch },
      }),
    ).toBe(false);
  },
);

it("uses controller exact quantity in both the research mandate and placement compiler", async () => {
  const recover = vi
    .spyOn(executionRecovery, "recoverConfirmedFinanceExecutions")
    .mockResolvedValue({
      replayed: [],
      alreadyRecorded: [],
      pendingReconciliation: [],
      legacyUnsupported: [],
      noFill: [],
      failures: [],
    });
  const place = vi
    .spyOn(alpacaRun, "runFinanceAlpacaOrder")
    .mockResolvedValue({ ok: false, stage: "place", refusals: ["offline placement sentinel"] });
  const input = {
    instrument: "BTC/USD",
    assetClass: "crypto" as const,
    modelText: JSON.stringify({
      conclusionId: "exact-reduction",
      instrument: "BTC/USD",
      assetClass: "crypto",
      direction: "sell",
      conviction: 0.9,
      thesis: "sourced reduction",
      invalidationPrice: 110,
      horizonDays: 30,
      evidence: [{ sourceId: "a" }, { sourceId: "b" }],
      quantityOverride: 999,
    }),
    evidence: ["a", "b"].map((sourceId) => ({
      sourceId,
      description: "fixture",
      detail: "offline evidence",
      sourceUrlOrArtifact: `fixture:${sourceId}`,
    })),
    market: { referencePrice: 100, referencePriceAt: "2026-09-22T00:00:00Z" },
    equity: 100000,
    runAuthorizationId: "offline-input",
  };
  const control = {
    mode: "alpaca_paper" as const,
    stateDirectory: "offline-only",
    recovery: {
      safetyStateDir: "offline-only",
      accountId: "fixture-account",
      venue: "alpaca:paper",
    },
    riskContext: {
      drawdownFraction: 0,
      averagingDown: false,
      revengeSizing: false,
      hasSignificantAutocorrelation: true,
    },
    execution: {
      market: input.market,
      equity: input.equity,
      runAuthorizationId: "controller-run",
      budget: {
        automation: "unattended" as const,
        allowedInstruments: ["BTC/USD"],
        maxOrderNotional: 1000,
        maxInstrumentNotional: 5000,
        maxOrdersPerRun: 8,
      },
      instruments: ["BTC/USD"],
      quantityOverride: 0.000399,
      createSafetyContext: () => ({ kind: "controller_execution_safety" as const }),
    },
  };
  try {
    const exact = await runFinanceResearchExecutionBridge(input, control);
    expect(exact).toMatchObject({
      status: "refused",
      decision: { passed: true, intent: { quantity: 0.000399 } },
      placement: { refusals: ["offline placement sentinel"] },
    });
    expect(place).toHaveBeenCalledWith(
      expect.objectContaining({
        quantityOverride: 0.000399,
        mode: "paper",
        runAuthorizationId: "controller-run",
      }),
    );
    place.mockClear();
    const oversized = await runFinanceResearchExecutionBridge(input, {
      ...control,
      execution: { ...control.execution, quantityOverride: 51 },
    });
    expect(oversized).toMatchObject({
      status: "refused",
      decision: { passed: false, intent: undefined },
    });
    expect(place).not.toHaveBeenCalled();
    const wrongAsset = await runFinanceResearchExecutionBridge(
      { ...input, assetClass: "us_equity" },
      control,
    );
    expect(wrongAsset).toMatchObject({
      status: "refused",
      refusals: ["model conclusion changed the authorized instrument or asset class"],
    });
    expect(place).not.toHaveBeenCalled();
  } finally {
    recover.mockRestore();
    place.mockRestore();
  }
});

describe("default recovery write authority", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  async function pendingReduction(options: { closed?: boolean; expired?: boolean } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "research-recovery-authority-"));
    directories.push(directory);
    const accountId = `fixture-${path.basename(directory)}`;
    const at = new Date(Date.now() - 2_000).toISOString();
    const filledAt = new Date(Date.now() - 1_000).toISOString();
    const expiresAt = new Date(Date.now() + (options.expired ? -1_000 : 60_000)).toISOString();
    const intent = {
      intentId: "old-protected-reduction",
      runAuthorizationId: "old-controller-run",
      instrument: "TSLA",
      side: "sell" as const,
      quantity: options.closed ? 2 : 1,
      orderType: "market" as const,
      referencePrice: 100,
      referencePriceAt: at,
      rationale: "offline pending recovery fixture",
    };
    const digest = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const clientId = `lcx-${digest(["paper", intent.runAuthorizationId, intent.intentId]).slice(0, 40)}`;
    const budget = {
      automation: "unattended" as const,
      allowedInstruments: ["TSLA"],
      maxOrderNotional: 1_000,
      maxInstrumentNotional: 5_000,
      maxOrdersPerRun: 8,
    };
    const claim: FinanceExecutionSafetyClaim = {
      id: digest([accountId, "alpaca:paper", intent.runAuthorizationId, intent.intentId]),
      run: intent.runAuthorizationId,
      instrument: intent.instrument,
      notional: intent.quantity * intent.referencePrice,
      snapshotId: "prior-controller-snapshot",
      at,
      status: "unknown",
      adapterKind: "venue",
      binding: {
        accountId,
        adapterId: "alpaca-venue",
        venue: "alpaca:paper",
        intent,
        budget,
        positionQuantity: 2,
        protectiveOrders: [{ id: "old-stop", quantity: 2, stopPrice: 90 }],
        policy: {
          planId: "old-plan",
          revision: "1",
          riskModel: "fully_funded_unhedged_spot",
          authorizedSide: "sell",
          authorizedQuantity: 2,
          expiresAt,
          maxPortfolioDrawdownFraction: 0.2,
          maxGrossExposure: 5_000,
          maxAccountAgeMs: 60_000,
          maxQuoteAgeMs: 60_000,
          maxInstrumentEvidenceAgeMs: 60_000,
        },
      },
    };
    await fs.writeFile(
      path.join(directory, `execution-safety-${digest(["alpaca:paper", accountId])}.jsonl`),
      `${JSON.stringify(claim)}\n`,
    );
    const terminal: Record<string, unknown> = {
      id: "terminal-sell",
      client_order_id: clientId,
      symbol: "TSLA",
      side: "sell",
      qty: String(intent.quantity),
      type: "market",
      time_in_force: "day",
      status: "filled",
      filled_qty: String(intent.quantity),
      filled_avg_price: "100",
      submitted_at: at,
      filled_at: filledAt,
      updated_at: filledAt,
    };
    const oldStop: Record<string, unknown> = {
      id: "old-stop",
      symbol: "TSLA",
      side: "sell",
      type: "stop",
      time_in_force: "gtc",
      status: "canceled",
      qty: "2",
      filled_qty: "0",
      stop_price: "90",
    };
    const read = vi.fn<writeTransport.FinanceUncachedFetch>(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/account") {
        return { status: 200, body: JSON.stringify({ id: accountId }) };
      }
      if (parsed.pathname === "/v2/orders:by_client_order_id") {
        return parsed.searchParams.get("client_order_id") === clientId
          ? { status: 200, body: JSON.stringify(terminal) }
          : { status: 404, body: "{}" };
      }
      if (parsed.pathname === "/v2/orders/old-stop") {
        return { status: 200, body: JSON.stringify(oldStop) };
      }
      if (parsed.pathname === "/v2/positions/TSLA") {
        return options.closed
          ? { status: 404, body: "{}" }
          : { status: 200, body: JSON.stringify({ symbol: "TSLA", side: "long", qty: "1" }) };
      }
      if (parsed.pathname === "/v2/orders") {
        return { status: 200, body: "[]" };
      }
      throw new Error(`unexpected offline recovery read: ${parsed.pathname}`);
    });
    const post = vi.fn<writeTransport.FinanceWriteTransport>(async (request) => ({
      status: 200,
      body: JSON.stringify({
        ...JSON.parse(request.body),
        id: "unexpected-restored-stop",
        status: "new",
        filled_qty: "0",
      }),
    }));
    vi.spyOn(credentialEnv, "resolveFinanceCredentialEnv").mockReturnValue({
      ALPACA_API_KEY_ID: "PK_OFFLINE_ONLY",
      ALPACA_API_SECRET_KEY: "offline-only-secret",
    });
    vi.spyOn(writeTransport, "createFinanceUncachedFetch").mockReturnValue(read);
    const writeFactory = vi
      .spyOn(writeTransport, "createFinanceWriteTransport")
      .mockReturnValue(post);
    const createSafetyContext = vi.fn(() => ({ kind: "controller_execution_safety" as const }));
    const control = {
      mode: "alpaca_paper" as const,
      stateDirectory: directory,
      recovery: { safetyStateDir: directory, accountId, venue: "alpaca:paper" },
      execution: {
        market: { referencePrice: 100, referencePriceAt: at },
        equity: 10_000,
        runAuthorizationId: "current-controller-run",
        budget: { ...budget, allowedInstruments: ["AAPL"] },
        instruments: ["AAPL"],
        createSafetyContext,
      },
    };
    const claims = () =>
      readFinanceExecutionSafetyClaims({
        stateDir: directory,
        accountId,
        venue: "alpaca:paper",
      });
    const rewriteClaim = (value: unknown) =>
      fs.writeFile(
        path.join(directory, `execution-safety-${digest(["alpaca:paper", accountId])}.jsonl`),
        `${JSON.stringify(value)}\n`,
      );
    return {
      control,
      claim,
      claims,
      rewriteClaim,
      terminal,
      oldStop,
      read,
      post,
      writeFactory,
      createSafetyContext,
    };
  }

  it.each(["outside_current_scope", "expired_policy", "no_execution"])(
    "retains an unprotected partial claim without acquiring writes: %s",
    async (mode) => {
      const f = await pendingReduction({ expired: mode === "expired_policy" });
      const control = mode === "no_execution" ? { ...f.control, execution: undefined } : f.control;
      if (mode === "expired_policy") {
        control.execution!.instruments = ["TSLA"];
        control.execution!.budget.allowedInstruments = ["TSLA"];
      }
      const result = await recoverFinanceResearchHistory(control);
      expect(f.post).not.toHaveBeenCalled();
      expect(f.writeFactory).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect(result.recovery?.pendingReconciliation).toEqual([f.claim.id]);
      expect((await f.claims()).at(-1)?.status).toBe("unknown");
      expect(f.createSafetyContext).not.toHaveBeenCalled();
    },
  );

  it("confirms a fully closed old position using only reads, even outside the new scope", async () => {
    const f = await pendingReduction({ closed: true, expired: true });
    expect(await recoverFinanceResearchHistory(f.control)).toMatchObject({ ok: true });
    expect((await f.claims()).at(-1)?.status).toBe("confirmed");
    const again = await recoverFinanceResearchHistory(f.control);
    expect(again).toMatchObject({ ok: true, recovery: { alreadyRecorded: [f.claim.id] } });
    expect(f.post).not.toHaveBeenCalled();
    expect(f.writeFactory).not.toHaveBeenCalled();
  });

  it.each([{ qty: "3" }, { filled_qty: true }, { stop_price: "91" }, { status: "new" }])(
    "retains a closed claim when its old protection is not verified: %j",
    async (patch) => {
      const f = await pendingReduction({ closed: true });
      Object.assign(f.oldStop, patch);
      expect((await recoverFinanceResearchHistory(f.control)).ok).toBe(false);
      expect((await f.claims()).at(-1)?.status).toBe("unknown");
      expect(f.post).not.toHaveBeenCalled();
    },
  );

  it.each([null, undefined, false, "not-a-number"])(
    "keeps a malformed durable protection quantity unknown: %j",
    async (quantity) => {
      const f = await pendingReduction({ closed: true });
      await f.rewriteClaim({
        ...f.claim,
        binding: {
          ...f.claim.binding,
          protectiveOrders: [{ ...f.claim.binding!.protectiveOrders![0], quantity }],
        },
      });
      expect((await recoverFinanceResearchHistory(f.control)).ok).toBe(false);
      expect((await f.claims()).at(-1)?.status).toBe("unknown");
      expect(f.read).not.toHaveBeenCalled();
      expect(f.post).not.toHaveBeenCalled();
    },
  );

  it.each([
    { positionQuantity: undefined },
    { positionQuantity: null },
    { positionQuantity: "2" },
    { positionQuantity: -1 },
    { protectiveOrders: null },
    { protectiveOrders: {} },
    { protectiveOrders: [null] },
    { protectiveOrders: [{ id: "old-stop", quantity: 3, stopPrice: 90 }] },
    { protectiveOrders: [{ id: "old-stop", quantity: 2, stopPrice: null }] },
    { protectiveOrders: [{ id: "old-stop", quantity: 2, stopPrice: 90, orderType: null }] },
    {
      protectiveOrders: [{ id: "old-stop", quantity: 2, stopPrice: 90, orderType: "stop_limit" }],
    },
    {
      protectiveOrders: [
        { id: "old-stop", quantity: 1, stopPrice: 90 },
        { id: "old-stop", quantity: 1, stopPrice: 90 },
      ],
    },
  ])("blocks malformed protection bindings before any supplied resolver: %j", async (patch) => {
    const f = await pendingReduction();
    await f.rewriteClaim({ ...f.claim, binding: { ...f.claim.binding, ...patch } });
    const resolvePending = vi.fn(async () => undefined);
    const result = await recoverFinanceResearchHistory({
      ...f.control,
      recovery: { ...f.control.recovery, resolvePending },
    });
    expect(result.ok).toBe(false);
    expect((await f.claims()).at(-1)?.status).toBe("unknown");
    expect(resolvePending).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });

  it("preserves read-only recovery of a legacy unprotected terminal sell", async () => {
    const f = await pendingReduction({ closed: true });
    const {
      protectiveOrders: _protection,
      positionQuantity: _position,
      ...binding
    } = f.claim.binding!;
    await f.rewriteClaim({ ...f.claim, binding });
    expect((await recoverFinanceResearchHistory(f.control)).ok).toBe(true);
    expect((await f.claims()).at(-1)?.status).toBe("confirmed");
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.writeFactory).not.toHaveBeenCalled();
  });
});
