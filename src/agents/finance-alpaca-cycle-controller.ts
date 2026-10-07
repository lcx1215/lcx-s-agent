import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readAlpacaPaperTerminalOrder } from "./finance-alpaca-execution-adapter.js";
import {
  readAlpacaPaperSafetyQuote,
  AlpacaSafetyQuoteReadError,
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
  FinanceExecutionSafetyFactsError,
  readFinanceExecutionSafetyClaims,
  type FinanceExecutionSafetyFacts,
} from "./finance-execution-safety.js";
import {
  createFinanceUncachedFetch,
  type FinanceUncachedFetch,
} from "./finance-write-transport.js";

/** Local controller configuration, never accepted from a strategy or model response. */
const financeAlpacaCyclePolicyFieldsSchema = z
  .object({
    schemaVersion: z.literal("lcx_alpaca_cycle_policy_v1"),
    accountId: z.string().trim().min(1),
    planId: z.string().trim().min(1),
    revision: z.string().trim().min(1),
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

export const financeAlpacaCyclePolicySchema = z.union([
  financeAlpacaCyclePolicyFieldsSchema
    .extend({
      authorizationMode: z.literal("until_expiry").default("until_expiry"),
      expiresAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  financeAlpacaCyclePolicyFieldsSchema
    .extend({ authorizationMode: z.literal("until_revoked") })
    .strict(),
]);

const STANDING_PAPER_OPERATION_AUTHORITY_MS = 120_000;

export type FinanceAlpacaCyclePolicy = z.infer<typeof financeAlpacaCyclePolicySchema>;
type PreparedReconciliation = {
  snapshot: Awaited<ReturnType<typeof syncFinanceBrokerReconciliation>>;
  claimFingerprint: string;
  latestClaimId?: string;
};
type Controller = Required<
  Pick<
    FinanceDailyCycleParams,
    "accountId" | "accountBookProvider" | "executionQuoteProvider" | "createSafetyContext"
  >
> & {
  prepareExecutionQuote: Controller["executionQuoteProvider"];
  /** Expiry of the policy snapshot validated when this controller was created. */
  executionPolicyExpiresAt: string | null;
  executionPolicyAuthorizationMode: "until_expiry" | "until_revoked";
  inspectReconciliation: (signal: AbortSignal) => Promise<{
    readiness: FinanceExecutionReconciliation;
    observedAt: string;
    protection?: Awaited<ReturnType<typeof syncFinanceBrokerReconciliation>>["protection"];
  }>;
};

export function createFinanceAlpacaCycleController(options: {
  directory: string;
  policy: unknown;
  instruments: readonly string[];
  feed: "iex" | "sip";
  maxAgeMs: number;
  /** Explicit spot-crypto maintenance capability; legacy daily universes stay equities-only. */
  allowCrypto?: boolean;
  /** Trusted maintenance opt-in: resolve unknown execution before minting a short quote lease. */
  recoverPendingBeforeQuote?: boolean;
  /** Controller-only additional ownership guard, called inside the shared dispatch lock. */
  validateFacts?: (facts: FinanceExecutionSafetyFacts, signal: AbortSignal) => Promise<void>;
  read?: FinanceUncachedFetch;
}): Controller {
  options = { ...options, instruments: [...options.instruments] };
  const policy = financeAlpacaCyclePolicySchema.parse(options.policy);
  const policyExpiresAt = policy.authorizationMode === "until_revoked" ? null : policy.expiresAt;
  const instruments = new Set(options.instruments);
  if (
    !instruments.size ||
    [...instruments].some(
      (s) =>
        !/^[A-Z][A-Z0-9.]{0,14}$/.test(s) &&
        !(options.allowCrypto === true && /^[A-Z][A-Z0-9]{0,14}\/USD$/.test(s)),
    ) ||
    !Number.isFinite(options.maxAgeMs) ||
    options.maxAgeMs <= 0 ||
    options.maxAgeMs > 120000 ||
    (policyExpiresAt !== null && Date.parse(policyExpiresAt) <= Date.now())
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
  const preparedQuotes = new Map<AlpacaSafetyQuoteBinding, PreparedReconciliation>();
  let reusableReconciliation: PreparedReconciliation | undefined;
  const claimFingerprint = (claims: Awaited<ReturnType<typeof readFinanceExecutionSafetyClaims>>) =>
    createHash("sha256").update(JSON.stringify(claims)).digest("hex");
  const reconciliationIsFresh = (prepared: PreparedReconciliation) => {
    const age = Date.now() - Date.parse(prepared.snapshot.observedAt);
    return Number.isFinite(age) && age >= 0 && age <= options.maxAgeMs;
  };

  // Standing Paper permission never becomes an unlimited order capability.
  const operationExpiresAt = () =>
    policyExpiresAt ?? new Date(Date.now() + STANDING_PAPER_OPERATION_AUTHORITY_MS).toISOString();

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
    authorityExpiresAt = operationExpiresAt(),
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
        diagnostics: true,
        timeoutMs: 20000,
        maxAgeMs: options.maxAgeMs,
        boundQuote,
        evidence: {
          accountId: policy.accountId,
          currency: "USD",
          source: `daily-controller:${policy.planId}:${policy.revision}`,
          observedAt: new Date().toISOString(),
          expiresAt: authorityExpiresAt,
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
      throw new FinanceExecutionSafetyFactsError("account_snapshot_unavailable", {
        reason: result.reason,
        stage: result.diagnostic,
        ...(result.accountArithmetic ? { accountArithmetic: result.accountArithmetic } : {}),
      });
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

  async function reconcile(
    signal: AbortSignal,
    { inspectOnly = false, recoverPending = true } = {},
  ) {
    // A failed or inspect-only refresh must not leave an older success reusable.
    reusableReconciliation = undefined;
    const recovery = await recoverConfirmedFinanceExecutions({
      safetyStateDir: options.directory,
      accountId: policy.accountId,
      venue: account.venue,
      ledgerDir: options.directory,
      signal,
      resolvePending: recoverPending
        ? async (claim, recoverySignal) => {
            const binding = claim.binding;
            if (
              !binding ||
              binding.accountId !== policy.accountId ||
              binding.venue !== account.venue ||
              binding.adapterId !== "alpaca-venue"
            ) {
              return undefined;
            }
            const { intent, protectiveOrders, positionQuantity } = binding;
            // A sell that consumed reserved protection also needs the existing
            // protection-recovery owner. A terminal fill alone cannot complete it.
            if (
              intent.side === "sell" &&
              protectiveOrders?.length &&
              (positionQuantity === undefined ||
                intent.quantity >
                  positionQuantity -
                    protectiveOrders.reduce((sum, order) => sum + order.quantity, 0))
            ) {
              return undefined;
            }
            return readAlpacaPaperTerminalOrder({
              accountId: policy.accountId,
              intent,
              credentials,
              read,
              signal: recoverySignal,
            });
          }
        : undefined,
    });
    // Pending execution authority must not stop the resident account feed.
    // Refresh broker facts before reporting the unchanged recovery refusal.
    const snapshot = await syncFinanceBrokerReconciliation({
      directory: options.directory,
      accountId: policy.accountId,
      after: "1970-01-01T00:00:00.000Z",
      until: new Date().toISOString(),
      credentials: { keyId: credentials.keyId, secretKey: credentials.secret },
      read,
      signal,
    });
    if (
      recovery.failures.length ||
      recovery.pendingReconciliation.length ||
      recovery.legacyUnsupported.length
    ) {
      throw new FinanceExecutionSafetyFactsError("execution_recovery_incomplete");
    }
    const claims = await readFinanceExecutionSafetyClaims({ ...account, signal });
    if (
      claims.some(
        (c) =>
          c.status === "reserved" ||
          c.status === "unknown" ||
          (c.status === "confirmed" && (!c.binding || !c.fill)),
      )
    ) {
      throw new FinanceExecutionSafetyFactsError("unresolved_execution_claims");
    }
    const last = claims.toReversed().find((claim) => claim.status === "confirmed");
    const latestClaim = claims.at(-1);
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
        throw new FinanceExecutionSafetyFactsError("terminal_order_mismatch");
      }
    }
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
      throw new FinanceExecutionSafetyFactsError("broker_reconciliation_blocked");
    }
    if (!inspectOnly) {
      reusableReconciliation = {
        snapshot,
        claimFingerprint: claimFingerprint(claims),
        latestClaimId: latestClaim?.id,
      };
    }
    return { snapshot, last, latestClaim, readiness };
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
      throw new FinanceExecutionSafetyFactsError("positions_changed");
    }
  }

  const executionQuoteProvider: Controller["executionQuoteProvider"] = async (request, signal) => {
    const crypto = request.instrument.includes("/");
    if (
      request.assetClass !== (crypto ? "crypto" : "us_equity") ||
      (crypto && options.allowCrypto !== true)
    ) {
      throw new Error("daily controller asset class outside explicit capability");
    }
    if (!instruments.has(request.instrument)) {
      throw new Error("instrument outside controller universe");
    }
    const observed = await readAlpacaPaperSafetyQuote(
      {
        instrument: request.instrument,
        side: request.side,
        stockFeed: options.feed,
        credentials,
        read,
        diagnostics: true,
        timeoutMs: 20000,
        maxAgeMs: options.maxAgeMs,
      },
      signal,
    );
    if (!observed.ok) {
      throw new AlpacaSafetyQuoteReadError(observed.reason, observed.diagnostic);
    }
    const key = `${request.instrument}:${request.side}`;
    const previous = quoteBindings.get(key);
    if (previous) {
      preparedQuotes.delete(previous);
    }
    quoteBindings.set(key, observed.boundQuote);
    return {
      referencePrice: observed.referencePrice,
      referencePriceAt: observed.observedAt,
      sourceUrlOrArtifact: observed.source,
      bidPrice: observed.bidPrice,
      askPrice: observed.askPrice,
      feed: options.feed,
      maxAgeMs: options.maxAgeMs,
    };
  };

  return {
    inspectReconciliation: async (signal) => {
      const { snapshot, readiness } = await reconcile(signal, { inspectOnly: true });
      return { readiness, observedAt: snapshot.observedAt, protection: snapshot.protection };
    },
    accountId: policy.accountId,
    executionPolicyExpiresAt: policyExpiresAt,
    executionPolicyAuthorizationMode: policy.authorizationMode,
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
        executionCapacity: Object.freeze({
          source: "controller_account_safety_facts" as const,
          accountId: policy.accountId,
          venue: "alpaca:paper" as const,
          observedAt: observed.facts.observedAt,
          expiresAt: observed.facts.expiresAt,
          policyPlanId: policy.planId,
          policyRevision: policy.revision,
          grossExposure: observed.facts.account.grossExposure,
          maxGrossExposure: policy.maxGrossExposure,
          uncertaintyReserve: reconciliation.uncertaintyReserve,
        }),
      };
    },
    executionQuoteProvider,
    prepareExecutionQuote: async (request, signal) => {
      // Reuse the existing reconciliation lease, never the quote or a renewed timestamp.
      // The final dispatch gate still checks fresh broker facts and the same journal.
      let prepared = reusableReconciliation;
      if (prepared) {
        const claims = await readFinanceExecutionSafetyClaims({ ...account, signal });
        if (
          !reconciliationIsFresh(prepared) ||
          claimFingerprint(claims) !== prepared.claimFingerprint
        ) {
          prepared = undefined;
        }
      }
      if (!prepared) {
        // Finish expensive history reads before starting the short execution-quote lease.
        const { snapshot, latestClaim } = await reconcile(signal, {
          recoverPending: options.recoverPendingBeforeQuote === true,
        });
        const claims = await readFinanceExecutionSafetyClaims({ ...account, signal });
        prepared = {
          snapshot,
          claimFingerprint: claimFingerprint(claims),
          latestClaimId: latestClaim?.id,
        };
      }
      const quote = await executionQuoteProvider(request, signal);
      const bound = quoteBindings.get(`${request.instrument}:${request.side}`);
      if (!bound) {
        throw new FinanceExecutionSafetyFactsError("quote_binding_missing");
      }
      if (!reconciliationIsFresh(prepared)) {
        throw new FinanceExecutionSafetyFactsError("account_snapshot_unavailable", {
          reason: "alpaca_safety_quote_expired",
          stage: "quote_binding",
        });
      }
      preparedQuotes.set(bound, prepared);
      return quote;
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
      const prepared = quote ? preparedQuotes.get(quote) : undefined;
      if (quote) {
        preparedQuotes.delete(quote);
      }
      const authorityExpiresAt = operationExpiresAt();
      return createFinanceExecutionSafetyContext({
        ...binding,
        ...account,
        policy: {
          planId: policy.planId,
          revision: policy.revision,
          riskModel: "fully_funded_unhedged_spot",
          authorizedSide: binding.intent.side,
          authorizedQuantity: binding.intent.quantity,
          expiresAt: authorityExpiresAt,
          maxGrossExposure: policy.maxGrossExposure,
          quantityDifferenceIsolation: policy.quantityDifferenceIsolation,
          maxPortfolioDrawdownFraction: policy.maxPortfolioDrawdownFraction,
          maxAccountAgeMs: options.maxAgeMs,
          maxQuoteAgeMs: options.maxAgeMs,
          maxInstrumentEvidenceAgeMs: options.maxAgeMs,
        },
        readFacts: async (signal) => {
          if (!quote) {
            throw new FinanceExecutionSafetyFactsError("quote_binding_missing");
          }
          // The execution gate already owns the account dispatch lock and has
          // rejected pending claims. Do not reacquire that lock during facts reads.
          const reconciled = prepared
            ? await (async () => {
                const claims = await readFinanceExecutionSafetyClaims({ ...account, signal });
                if (!reconciliationIsFresh(prepared)) {
                  throw new FinanceExecutionSafetyFactsError("account_snapshot_unavailable", {
                    reason: "alpaca_safety_quote_expired",
                    stage: "quote_binding",
                  });
                }
                if (claimFingerprint(claims) !== prepared.claimFingerprint) {
                  throw new FinanceExecutionSafetyFactsError("broker_reconciliation_unavailable");
                }
                return { snapshot: prepared.snapshot, latestClaim: { id: prepared.latestClaimId } };
              })()
            : await reconcile(signal, { recoverPending: false }).catch((error: unknown) => {
                if (error instanceof FinanceExecutionSafetyFactsError) {
                  throw error;
                }
                throw new FinanceExecutionSafetyFactsError("broker_reconciliation_unavailable");
              });
          const { snapshot, latestClaim } = reconciled;
          const observed = await facts(
            binding.intent.instrument,
            binding.intent.side,
            signal,
            quote,
            latestClaim?.id,
            authorityExpiresAt,
          );
          assertSamePositions(observed.positions, snapshot.positions);
          if (Math.abs(observed.facts.account.availableCash - snapshot.brokerCash) > 0.01) {
            throw new FinanceExecutionSafetyFactsError("cash_changed");
          }
          const lockedFacts = {
            ...observed.facts,
            reconciliation: readinessFor(snapshot, observed.positions),
          };
          await options.validateFacts?.(lockedFacts, signal);
          return lockedFacts;
        },
      });
    },
  };
}
