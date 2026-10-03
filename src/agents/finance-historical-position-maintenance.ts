import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readFinanceAccountTradingBook } from "./finance-account-trading-book.js";
import {
  createFinanceAlpacaCycleController,
  financeAlpacaCyclePolicySchema,
} from "./finance-alpaca-cycle-controller.js";
import { createAlpacaExecutionAdapter } from "./finance-alpaca-execution-adapter.js";
import {
  createFinanceAlpacaMarketSessionResolver,
  financeAlpacaMarketSessionIssue,
  type FinanceAlpacaMarketSession,
} from "./finance-alpaca-market-calendar.js";
import { readFinanceBrokerReconciliation } from "./finance-broker-reconciliation.js";
import {
  placeFinanceOrder,
  type FinanceExecutionIntent,
  type FinanceRiskBudget,
} from "./finance-execution-adapter.js";
import { readFinanceExecutionSafetyClaims } from "./finance-execution-safety.js";
import {
  appendFinanceExecutionReceipt,
  readFinanceAccountPositionLedger,
} from "./finance-position-ledger.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";
import {
  createFinanceWriteTransport,
  type FinanceUncachedFetch,
  type FinanceWriteTransport,
} from "./finance-write-transport.js";

export type FinanceHistoricalMaintenanceDecision = {
  id: string;
  instrument: string;
  quantity: number;
  status: "blocked" | "placed" | "refused" | "unknown";
  reasons: string[];
  receiptId?: string;
  filledQuantity?: number;
  remainingQuantity?: number;
};
export type FinanceHistoricalMaintenanceResult = {
  status: "idle" | "completed" | "blocked";
  observedAt: string;
  decisions: FinanceHistoricalMaintenanceDecision[];
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const preflightReasons = new Set([
  "historical_inventory_changed",
  "historical_inventory_ownership_changed",
  "historical_inventory_changed_under_account_lock",
  "historical_exit_bid_required",
  "historical_maintenance_pending_claim",
  "historical_maintenance_attempt_budget_exhausted",
  "historical_maintenance_outside_cash_session",
  "historical_maintenance_calendar_unavailable",
  "unresolved_execution_claims",
  "execution_recovery_incomplete",
  "quote_binding_missing",
  "alpaca_safety_quote_expired",
  "account_snapshot_unavailable",
  "broker_reconciliation_unavailable",
  "positions_changed",
  "cash_changed",
]);
const cashSessionOpen = (session: FinanceAlpacaMarketSession | null) =>
  session !== null &&
  !financeAlpacaMarketSessionIssue(session) &&
  Date.now() >= Date.parse(session.openAt) &&
  Date.now() < Date.parse(session.closeAt);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Account inventory maintenance, not a prediction or a claim to the historical entry strategy. */
export async function runFinanceHistoricalPositionMaintenance(options: {
  directory: string;
  policy: unknown;
  budget: FinanceRiskBudget;
  feed: "iex" | "sip";
  maxAgeMs: number;
  signal: AbortSignal;
  read?: FinanceUncachedFetch;
  transport?: FinanceWriteTransport;
}): Promise<FinanceHistoricalMaintenanceResult> {
  const observedAt = new Date().toISOString();
  const result: FinanceHistoricalMaintenanceResult = { status: "idle", observedAt, decisions: [] };
  options.signal.throwIfAborted();
  const policy = financeAlpacaCyclePolicySchema.parse(options.policy);
  const account = { accountId: policy.accountId, venue: "alpaca:paper" as const };
  const [book, strategies, reconciliation] = await Promise.all([
    readFinanceAccountTradingBook({ directory: options.directory, ...account }),
    readFinanceStrategyRuleLedger(options.directory),
    readFinanceBrokerReconciliation(options.directory, policy.accountId),
  ]);
  if (!book.brokerBaselineUsable || !reconciliation.ok) {
    return { ...result, status: "blocked" };
  }
  const snapshot = object(reconciliation.snapshot);
  const snapshotAge = Date.now() - Date.parse(String(snapshot.observedAt));
  if (
    !Number.isFinite(snapshotAge) ||
    snapshotAge < 0 ||
    snapshotAge > options.maxAgeMs ||
    object(snapshot.accountObservation).accountId !== policy.accountId ||
    object(snapshot.accountObservation).source !== "https://paper-api.alpaca.markets/v2/account" ||
    book.accountId !== policy.accountId ||
    book.venue !== "alpaca:paper"
  ) {
    return { ...result, status: "blocked" };
  }
  const protection = object(snapshot.protection);
  const coverage = Array.isArray(protection.coverage) ? protection.coverage.map(object) : [];
  if (
    !Array.isArray(snapshot.openOrders) ||
    !Array.isArray(protection.unresolved) ||
    protection.unresolved.length > 0
  ) {
    return { ...result, status: "blocked" };
  }
  const receiptOrders = new Set(
    book.execution.receipts.flatMap((receipt) =>
      receipt.fill.terminalOrderIdentity?.orderId
        ? [receipt.fill.terminalOrderIdentity.orderId]
        : [],
    ),
  );
  const candidate = book.positions.find((position) => {
    if (
      !Number.isFinite(position.quantity) ||
      position.quantity <= 0 ||
      !book.historicalOnlyInstruments.includes(position.instrument)
    ) {
      return false;
    }
    if (
      strategies.ledger.rules.some(
        (rule) =>
          rule.state === "active" &&
          (rule.instruments.includes(position.instrument) || rule.instruments.includes("*")),
      )
    ) {
      return false;
    }
    if (
      book.execution.receipts.some(
        (receipt) =>
          receipt.instrument === position.instrument &&
          receipt.side === "buy" &&
          receipt.fill.filledQuantity > 0,
      )
    ) {
      return false;
    }
    const sources = book.brokerHistory.fills.filter(
      (fill) => fill.instrument === position.instrument,
    );
    if (
      !sources.some((fill) => fill.side === "buy") ||
      sources.some(
        (fill) =>
          !fill.sourceFactRef ||
          !fill.orderId ||
          (receiptOrders.has(fill.orderId) && fill.side === "buy"),
      )
    ) {
      return false;
    }
    const held = coverage.find((item) => item.instrument === position.instrument);
    return (
      held?.status === "no_recognized_stop" &&
      held.positionQuantity === position.quantity &&
      held.recognizedStopQuantity === 0 &&
      held.uncoveredQuantity === position.quantity &&
      (snapshot.openOrders as unknown[]).every((order) => {
        const symbol = object(order).symbol;
        return symbol !== position.instrument && symbol !== position.instrument.replace("/", "");
      })
    );
  });
  if (!candidate) {
    return result;
  }
  const instrument = candidate.instrument;
  const sourceFills = book.brokerHistory.fills.filter((fill) => fill.instrument === instrument);
  const id = hash([
    account,
    policy.planId,
    policy.revision,
    instrument,
    sourceFills
      .filter((fill) => fill.side === "buy")
      .map((fill) => [fill.activityId, fill.sourceFactRef])
      .toSorted((left, right) => {
        const leftKey = JSON.stringify(left);
        const rightKey = JSON.stringify(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  ]);
  const decision: FinanceHistoricalMaintenanceDecision = {
    id,
    instrument,
    quantity: candidate.quantity,
    status: "blocked",
    reasons: [],
  };
  result.decisions.push(decision);
  const decisionPath = path.join(
    options.directory,
    "historical-position-maintenance",
    `${id}.jsonl`,
  );
  await fs.mkdir(path.dirname(decisionPath), { recursive: true, mode: 0o700 });
  const persist = async (body: unknown) => {
    const file = await fs.open(decisionPath, "a", 0o600);
    try {
      await file.writeFile(JSON.stringify(body) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    const folder = await fs.open(path.dirname(decisionPath), "r");
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  };
  // A stable decision/intent identity delegates duplicate and unknown-outcome handling to the
  // existing account journal and controller recovery; the receipt remains a genuine venue sell.
  await persist({
    schemaVersion: "lcx_historical_position_maintenance_v1",
    observedAt,
    decision: "exit_unmanaged_unprotected_historical_position",
    ...decision,
    authority: { planId: policy.planId, revision: policy.revision, mode: "alpaca:paper" },
    strategyOwner: "unknown",
    sourceFillRefs: sourceFills.map((fill) => fill.sourceFactRef),
    sourceFeeRefs: book.brokerHistory.fees
      .filter((fee) => fee.instrument === instrument)
      .map((fee) => fee.sourceFactRef),
    assetFeeAdjusted: book.brokerHistory.assetFeeAdjustedInstruments.includes(instrument),
  });
  const runAuthorizationId = `historical-maintenance:${policy.planId}:${id}`;
  let intentId = `historical-maintenance:${id}:attempt:0`;
  let venueReceiptAvailable = false;
  let phase:
    | "calendar"
    | "prepare_quote"
    | "ownership_preflight"
    | "shared_gate"
    | "receipt_delivery" = "calendar";
  try {
    let session: FinanceAlpacaMarketSession | null = null;
    if (!instrument.includes("/")) {
      const date = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      try {
        session = await createFinanceAlpacaMarketSessionResolver({
          directory: options.directory,
          read: options.read,
        })(date, options.signal);
      } catch {
        throw new Error("historical_maintenance_calendar_unavailable");
      }
      if (!cashSessionOpen(session)) {
        throw new Error("historical_maintenance_outside_cash_session");
      }
    }
    const controller = createFinanceAlpacaCycleController({
      directory: options.directory,
      policy,
      instruments: [instrument],
      feed: options.feed,
      maxAgeMs: options.maxAgeMs,
      allowCrypto: true,
      recoverPendingBeforeQuote: true,
      validateFacts: async (facts, signal) => {
        signal.throwIfAborted();
        if (!instrument.includes("/") && !cashSessionOpen(session)) {
          throw new Error("historical_maintenance_outside_cash_session");
        }
        const [lockedReceipts, lockedStrategies] = await Promise.all([
          readFinanceAccountPositionLedger(options.directory, account),
          readFinanceStrategyRuleLedger(options.directory),
        ]);
        if (
          facts.reconciliation?.status !== "ready" ||
          facts.positionQuantity !== candidate.quantity ||
          (facts.reservedSellQuantity ?? 0) !== 0 ||
          (facts.protectiveOrders?.length ?? 0) !== 0 ||
          facts.openOrderIds.length !== 0 ||
          facts.unresolvedOrderIds.length !== 0 ||
          lockedReceipts.receipts.some(
            (receipt) =>
              receipt.instrument === instrument &&
              receipt.side === "buy" &&
              receipt.fill.filledQuantity > 0,
          ) ||
          lockedStrategies.ledger.rules.some(
            (rule) =>
              rule.state === "active" &&
              (rule.instruments.includes(instrument) || rule.instruments.includes("*")),
          )
        ) {
          throw new Error("historical_inventory_changed_under_account_lock");
        }
      },
      read: options.read,
    });
    phase = "prepare_quote";
    await persist({ at: new Date().toISOString(), phase });
    // Expensive recovery/history reconciliation finishes before the controller creates the
    // 30-second quote lease. Only the small, hash-verified receipt table is read after this.
    const assetClass = instrument.includes("/") ? "crypto" : "us_equity";
    const quote = await controller.prepareExecutionQuote(
      { instrument, assetClass, side: "sell" },
      options.signal,
    );
    if (!quote.bidPrice || quote.referencePrice !== quote.bidPrice) {
      throw new Error("historical_exit_bid_required");
    }
    phase = "ownership_preflight";
    await persist({ at: new Date().toISOString(), phase });
    const [latestReceipts, latestStrategies, claims] = await Promise.all([
      readFinanceAccountPositionLedger(options.directory, account),
      readFinanceStrategyRuleLedger(options.directory),
      readFinanceExecutionSafetyClaims({
        stateDir: options.directory,
        ...account,
        signal: options.signal,
      }),
    ]);
    if (
      latestReceipts.receipts.some(
        (receipt) =>
          receipt.instrument === instrument &&
          receipt.side === "buy" &&
          receipt.fill.filledQuantity > 0,
      ) ||
      latestStrategies.ledger.rules.some(
        (rule) =>
          rule.state === "active" &&
          (rule.instruments.includes(instrument) || rule.instruments.includes("*")),
      )
    ) {
      throw new Error("historical_inventory_ownership_changed");
    }
    const runClaims = claims.filter((claim) => claim.run === runAuthorizationId);
    if (runClaims.some((claim) => claim.status === "reserved" || claim.status === "unknown")) {
      throw new Error("historical_maintenance_pending_claim");
    }
    if (
      !Number.isSafeInteger(options.budget.maxOrdersPerRun) ||
      (options.budget.maxOrdersPerRun ?? 0) <= 0 ||
      runClaims.length >= (options.budget.maxOrdersPerRun ?? 0)
    ) {
      throw new Error("historical_maintenance_attempt_budget_exhausted");
    }
    // Terminal rejection/non-start and confirmed partial reductions may retry only with a
    // journal-derived attempt ordinal inside the same capped run. Unknown claims never advance.
    intentId = `historical-maintenance:${id}:attempt:${runClaims.length}`;
    const intent: FinanceExecutionIntent = {
      intentId,
      decisionRef: { source: "account_position_maintenance", id },
      instrument,
      side: "sell",
      orderType: "market",
      quantity: candidate.quantity,
      referencePrice: quote.bidPrice,
      referencePriceAt: quote.referencePriceAt,
      runAuthorizationId,
      rationale:
        "exit_unmanaged_unprotected_historical_position: reconciled historical long inventory has no LCX entry, active strategy, or recognized protection; reduce exposure only",
    };
    await persist({ at: new Date().toISOString(), phase: "dispatch_ready", intent });
    const transport =
      options.transport ?? createFinanceWriteTransport({ directory: options.directory });
    const adapter = createAlpacaExecutionAdapter({
      id: "alpaca-venue",
      credentialStateDirectory: options.directory,
      mode: "paper",
      instruments: [instrument],
      orderTypes: ["market"],
      timeInForce: assetClass === "crypto" ? "gtc" : "day",
      statusFetch: options.read,
      fillPoll: { timeoutMs: 60000, intervalMs: 1000 },
      postJson: (url, init) => transport({ url, ...init }),
    });
    phase = "shared_gate";
    const placement = await placeFinanceOrder({
      mode: "live_execution",
      intent,
      budget: options.budget,
      adapters: [adapter],
      executionAdapterId: adapter.id,
      safetyContext: controller.createSafetyContext({
        intent,
        budget: options.budget,
        adapterId: adapter.id,
        venue: adapter.venue,
      }),
      committedInstrumentNotional: claims
        .filter((claim) => claim.run === runAuthorizationId && claim.instrument === instrument)
        .reduce((sum, claim) => sum + claim.notional, 0),
      ordersPlacedThisRun: claims.filter((claim) => claim.run === runAuthorizationId).length,
      signal: options.signal,
    });
    if (placement.status === "placed" && placement.receipt) {
      phase = "receipt_delivery";
      venueReceiptAvailable = true;
      await appendFinanceExecutionReceipt(options.directory, placement.receipt);
      decision.status = "placed";
      decision.receiptId = placement.receipt.receiptId;
      decision.filledQuantity = placement.receipt.fill.filledQuantity;
      decision.remainingQuantity = Math.max(0, candidate.quantity - decision.filledQuantity);
      result.status = decision.remainingQuantity < 1e-10 ? "completed" : "blocked";
      if (result.status === "blocked") {
        decision.reasons = ["historical_reduction_not_fully_filled"];
      }
    } else {
      decision.status = "refused";
      decision.reasons = [...placement.refusalReasons];
      result.status = "blocked";
    }
  } catch (error) {
    result.status = "blocked";
    const category = object(error).category;
    const preflightReason =
      error instanceof Error && preflightReasons.has(error.message)
        ? error.message
        : typeof category === "string" && preflightReasons.has(category)
          ? category
          : "historical_maintenance_pre_dispatch_blocked";
    try {
      const claim = (
        await readFinanceExecutionSafetyClaims({
          stateDir: options.directory,
          ...account,
          signal: options.signal,
        })
      ).find(
        (item) =>
          item.run === runAuthorizationId &&
          (item.binding?.intent.intentId === intentId ||
            item.status === "reserved" ||
            item.status === "unknown"),
      );
      decision.status =
        claim?.status === "reserved" || claim?.status === "unknown" || venueReceiptAvailable
          ? "unknown"
          : "blocked";
      decision.reasons = [
        venueReceiptAvailable
          ? "historical_maintenance_receipt_delivery_pending"
          : decision.status === "unknown"
            ? "historical_maintenance_requires_reconciliation"
            : preflightReason !== "historical_maintenance_pre_dispatch_blocked"
              ? preflightReason
              : claim?.status === "rejected" || claim?.status === "not_started"
                ? "historical_maintenance_terminal_refusal"
                : claim
                  ? "historical_maintenance_already_claimed"
                  : "historical_maintenance_pre_dispatch_blocked",
      ];
    } catch {
      decision.status = "unknown";
      decision.reasons = ["historical_maintenance_journal_unavailable"];
    }
  }
  await persist({
    at: new Date().toISOString(),
    phase: "result",
    stoppedAtPhase: phase,
    ...decision,
  });
  return result;
}
