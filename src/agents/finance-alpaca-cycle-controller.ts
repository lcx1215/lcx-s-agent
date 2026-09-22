import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readAlpacaPaperTerminalOrder } from "./finance-alpaca-execution-adapter.js";
import {
  readAlpacaPaperSafetyFacts,
  type AlpacaSafetyQuoteBinding,
} from "./finance-alpaca-safety-provider.js";
import {
  assessFinanceBrokerExecutionReadiness,
  type FinanceExecutionReconciliation,
  brokerSymbol,
  syncFinanceBrokerReconciliation,
} from "./finance-broker-reconciliation.js";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import type { FinanceDailyCycleParams } from "./finance-daily-cycle.js";
import { recoverConfirmedFinanceExecutions } from "./finance-execution-recovery.js";
import {
  createFinanceExecutionSafetyContext,
  readFinanceExecutionSafetyClaims,
} from "./finance-execution-safety.js";
import {
  createFinanceUncachedFetch,
  type FinanceUncachedFetch,
} from "./finance-write-transport.js";

/** Local controller configuration, never accepted from a strategy or model response. */
export const financeAlpacaCyclePolicySchema = z
  .object({
    schemaVersion: z.literal("lcx_alpaca_cycle_policy_v1"),
    accountId: z.string().trim().min(1),
    planId: z.string().trim().min(1),
    revision: z.string().trim().min(1),
    expiresAt: z.string().datetime({ offset: true }),
    peakEquity: z.number().positive().finite(),
    peakScope: z.string().trim().min(1),
    unhedged: z.literal(true),
    maxPortfolioDrawdownFraction: z.number().min(0).lt(1),
    maxGrossExposure: z.number().positive().finite(),
    quantityDifferenceIsolation: z
      .object({
        instruments: z.array(z.string().regex(/^[A-Z0-9.]+(?:\/[A-Z]+)?$/)).min(1),
        maxUnexplainedNotional: z.number().positive().finite(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type FinanceAlpacaCyclePolicy = z.infer<typeof financeAlpacaCyclePolicySchema>;
type Controller = Required<
  Pick<
    FinanceDailyCycleParams,
    "accountId" | "accountBookProvider" | "executionQuoteProvider" | "createSafetyContext"
  >
> & {
  inspectReconciliation: (
    signal: AbortSignal,
  ) => Promise<{ readiness: FinanceExecutionReconciliation; observedAt: string }>;
};

export function createFinanceAlpacaCycleController(options: {
  directory: string;
  policy: unknown;
  instruments: readonly string[];
  feed: "iex" | "sip";
  maxAgeMs: number;
  read?: FinanceUncachedFetch;
}): Controller {
  options = { ...options, instruments: [...options.instruments] };
  const policy = financeAlpacaCyclePolicySchema.parse(options.policy);
  const instruments = new Set(options.instruments);
  if (
    !instruments.size ||
    [...instruments].some((s) => !/^[A-Z][A-Z0-9.]{0,14}$/.test(s)) ||
    !Number.isFinite(options.maxAgeMs) ||
    options.maxAgeMs <= 0 ||
    options.maxAgeMs > 120000 ||
    Date.parse(policy.expiresAt) <= Date.now()
  ) {
    throw new Error("invalid or expired Alpaca daily controller configuration");
  }
  const env = resolveFinanceCredentialEnv({
    ...process.env,
    LCX_FINANCE_STATE_DIR: options.directory,
  });
  const credentials = {
    keyId: env.ALPACA_API_KEY_ID ?? "",
    secret: env.ALPACA_API_SECRET_KEY ?? "",
  };
  if (!credentials.keyId.startsWith("PK") || !credentials.secret) {
    throw new Error("Alpaca daily controller requires configured paper credentials");
  }
  const read = options.read ?? createFinanceUncachedFetch({ directory: options.directory });
  const account = {
    stateDir: options.directory,
    accountId: policy.accountId,
    venue: "alpaca:paper",
  };
  const peakFile = path.join(
    options.directory,
    `account-peak-${createHash("sha256")
      .update(JSON.stringify([account.venue, policy.accountId, policy.peakScope]))
      .digest("hex")}.jsonl`,
  );
  const quoteBindings = new Map<string, AlpacaSafetyQuoteBinding>();

  async function readPeak() {
    try {
      if ((await fs.stat(peakFile)).size > 1024 * 1024) {
        throw new Error("account peak history exceeds bounded read");
      }
      const raw = await fs.readFile(peakFile, "utf8");
      if (raw && !raw.endsWith("\n")) {
        throw new Error("incomplete account peak history");
      }
      let peak = policy.peakEquity;
      for (const line of raw.split("\n").filter(Boolean)) {
        const row = JSON.parse(line) as { peakEquity?: unknown; observedAt?: unknown };
        if (
          typeof row.peakEquity !== "number" ||
          !Number.isFinite(row.peakEquity) ||
          row.peakEquity <= 0 ||
          typeof row.observedAt !== "string" ||
          !Number.isFinite(Date.parse(row.observedAt)) ||
          Date.parse(row.observedAt) > Date.now()
        ) {
          throw new Error("invalid account peak history");
        }
        peak = Math.max(peak, row.peakEquity);
      }
      return peak;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return policy.peakEquity;
      }
      throw error;
    }
  }

  async function facts(
    instrument: string,
    side: "buy" | "sell",
    signal: AbortSignal,
    boundQuote?: AlpacaSafetyQuoteBinding,
    reconciledThroughClaimId?: string,
  ) {
    if (!instruments.has(instrument)) {
      throw new Error("instrument outside controller universe");
    }
    const peak = await readPeak();
    const result = await readAlpacaPaperSafetyFacts(
      {
        accountId: policy.accountId,
        instrument,
        side,
        stockFeed: options.feed,
        credentials,
        read,
        timeoutMs: 20000,
        maxAgeMs: options.maxAgeMs,
        boundQuote,
        evidence: {
          accountId: policy.accountId,
          currency: "USD",
          source: `daily-controller:${policy.planId}:${policy.revision}`,
          observedAt: new Date().toISOString(),
          expiresAt: policy.expiresAt,
          peakEquity: peak,
          peakScope: policy.peakScope,
          trackNewHigh: true,
          unhedged: true,
          unresolvedOrderIds: [],
          reconciledThroughClaimId,
        },
      },
      signal,
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    signal.throwIfAborted();
    if (result.facts.account.peakEquity > peak) {
      // Append observations rather than overwriting a competing controller's higher peak.
      await fs.appendFile(
        peakFile,
        JSON.stringify({
          peakEquity: result.facts.account.peakEquity,
          observedAt: result.facts.observedAt,
        }) + "\n",
      );
    }
    return result;
  }

  async function reconcile(signal: AbortSignal, inspectOnly = false) {
    const recovery = await recoverConfirmedFinanceExecutions({
      safetyStateDir: options.directory,
      accountId: policy.accountId,
      venue: account.venue,
      ledgerDir: options.directory,
      signal,
    });
    if (
      recovery.failures.length ||
      recovery.pendingReconciliation.length ||
      recovery.legacyUnsupported.length
    ) {
      throw new Error("account execution recovery incomplete");
    }
    const claims = await readFinanceExecutionSafetyClaims({ ...account, signal });
    if (claims.some((c) => c.status !== "confirmed" || !c.binding || !c.fill)) {
      throw new Error("account has unresolved execution claims; recovery required");
    }
    const last = claims.at(-1);
    if (last?.binding && last.fill) {
      const terminal = await readAlpacaPaperTerminalOrder({
        accountId: policy.accountId,
        intent: last.binding.intent,
        credentials,
        read,
        signal,
      });
      if (
        !terminal ||
        terminal.terminalOrderIdentity?.orderId !== last.fill.terminalOrderIdentity?.orderId ||
        terminal.filledQuantity !== last.fill.filledQuantity ||
        terminal.fillPrice !== last.fill.fillPrice
      ) {
        throw new Error("last confirmed execution no longer matches broker evidence");
      }
    }
    const snapshot = await syncFinanceBrokerReconciliation({
      directory: options.directory,
      accountId: policy.accountId,
      after: "1970-01-01T00:00:00.000Z",
      until: new Date().toISOString(),
      credentials: { keyId: credentials.keyId, secretKey: credentials.secret },
      read,
      signal,
    });
    let readiness = readinessFor(
      snapshot,
      snapshot.positions.map((p) => ({
        instrument: brokerSymbol(p.symbol),
        quantity: Number(p.qty),
        marketValue: Number(p.market_value),
      })),
    );
    if (snapshot.protection.unresolved.length) {
      readiness = {
        ...readiness,
        status: "blocked",
        reasons: [...readiness.reasons, "open_orders_unresolved"],
      };
    }
    if (!inspectOnly && readiness.status === "blocked") {
      throw new Error("broker economics or open orders unresolved; placement unavailable");
    }
    return { snapshot, last, readiness };
  }

  function readinessFor(
    snapshot: Awaited<ReturnType<typeof syncFinanceBrokerReconciliation>>,
    positions: readonly { instrument: string; quantity: number; marketValue: number }[],
  ) {
    return assessFinanceBrokerExecutionReadiness({
      reconciliation: snapshot,
      positions,
      isolation: policy.quantityDifferenceIsolation,
    });
  }

  function assertSamePositions(
    positions: readonly { instrument: string; quantity: number }[],
    reconciled: readonly Record<string, unknown>[],
  ) {
    const expected = new Map(reconciled.map((p) => [brokerSymbol(p.symbol), Number(p.qty)]));
    if (
      positions.length !== expected.size ||
      positions.some((p) => expected.get(p.instrument) !== p.quantity)
    ) {
      throw new Error("positions changed after reconciliation; refresh required");
    }
  }

  return {
    inspectReconciliation: async (signal) => {
      const { snapshot, readiness } = await reconcile(signal, true);
      return { readiness, observedAt: snapshot.observedAt };
    },
    accountId: policy.accountId,
    accountBookProvider: async (signal) => {
      const { snapshot } = await reconcile(signal);
      const observed = await facts(options.instruments[0], "buy", signal);
      assertSamePositions(observed.positions, snapshot.positions);
      const reconciliation = readinessFor(snapshot, observed.positions);
      if (reconciliation.status === "blocked") {
        throw new Error("updated uncertainty exceeds isolation policy");
      }
      return {
        reconciliation,
        accountId: policy.accountId,
        venue: "alpaca:paper",
        observedAt: observed.facts.observedAt,
        expiresAt: observed.facts.expiresAt,
        equity: observed.facts.account.equity,
        positions: observed.positions,
      };
    },
    executionQuoteProvider: async (request, signal) => {
      if (request.assetClass !== "us_equity") {
        throw new Error("daily controller supports US equities only");
      }
      const observed = await facts(request.instrument, request.side, signal);
      quoteBindings.set(`${request.instrument}:${request.side}`, observed.boundQuote);
      return {
        referencePrice: observed.facts.quote.price,
        referencePriceAt: observed.facts.quote.observedAt,
        sourceUrlOrArtifact: observed.facts.quote.source,
        bidPrice: observed.bidPrice,
        askPrice: observed.askPrice,
        feed: options.feed,
        maxAgeMs: options.maxAgeMs,
      };
    },
    createSafetyContext: (binding) => {
      if (
        binding.adapterId !== "alpaca-venue" ||
        binding.venue !== account.venue ||
        !instruments.has(binding.intent.instrument)
      ) {
        throw new Error("daily execution binding mismatch");
      }
      const quote = quoteBindings.get(`${binding.intent.instrument}:${binding.intent.side}`);
      quoteBindings.delete(`${binding.intent.instrument}:${binding.intent.side}`);
      return createFinanceExecutionSafetyContext({
        ...binding,
        ...account,
        policy: {
          planId: policy.planId,
          revision: policy.revision,
          riskModel: "fully_funded_unhedged_spot",
          authorizedSide: binding.intent.side,
          authorizedQuantity: binding.intent.quantity,
          expiresAt: policy.expiresAt,
          maxGrossExposure: policy.maxGrossExposure,
          quantityDifferenceIsolation: policy.quantityDifferenceIsolation,
          maxPortfolioDrawdownFraction: policy.maxPortfolioDrawdownFraction,
          maxAccountAgeMs: options.maxAgeMs,
          maxQuoteAgeMs: options.maxAgeMs,
          maxInstrumentEvidenceAgeMs: options.maxAgeMs,
        },
        readFacts: async (signal) => {
          if (!quote) {
            throw new Error("controller quote binding missing");
          }
          const { snapshot, last } = await reconcile(signal);
          const observed = await facts(
            binding.intent.instrument,
            binding.intent.side,
            signal,
            quote,
            last?.id,
          );
          assertSamePositions(observed.positions, snapshot.positions);
          if (Math.abs(observed.facts.account.availableCash - snapshot.brokerCash) > 0.01) {
            throw new Error("cash changed after reconciliation; refresh required");
          }
          return { ...observed.facts, reconciliation: readinessFor(snapshot, observed.positions) };
        },
      });
    },
  };
}
