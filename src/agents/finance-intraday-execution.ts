import { financeAlpacaMarketSessionIssue } from "./finance-alpaca-market-calendar.js";
import {
  compileFinanceAlpacaOrderIntent,
  runFinanceAlpacaOrder,
  type FinanceAlpacaRunRequest,
} from "./finance-alpaca-run.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import {
  executionQuoteIssue,
  recordCycleFill,
  type FinanceDailyCycleParams,
  type FinanceDailyCycleExecutionQuote,
} from "./finance-daily-cycle.js";
import {
  FinanceExecutionSafetyFactsError,
  FinanceExecutionSafetyTerminalFailureError,
  FinanceExecutionSafetyUncertainError,
  readFinanceExecutionSafetyClaims,
} from "./finance-execution-safety.js";
import {
  appendFinanceIntradayOutcome,
  FinanceIntradayDecisionReviewReceiptSchema,
  readFinanceIntradayOutcome,
  readFinanceIntradayDecisions,
  type FinanceIntradayDecisionRecord,
  type FinanceIntradayDecisionReviewReceipt,
  type FinanceIntradayOutcomeInput,
} from "./finance-intraday-control-ledger.js";
import {
  FINANCE_INTRADAY_OPENING_RANGE_FORM,
  type FinanceIntradayActiveRuleContract,
  resolveFinanceIntradayActiveRuleContract,
} from "./finance-intraday-paper.js";
import {
  readFinanceIntradayOwnedPositions,
  receiptsForIntradayStrategy,
} from "./finance-intraday-position.js";
import { readFinancePositionRecords } from "./finance-position-ledger.js";
import { readFinanceResearchEquityUniverseSnapshot } from "./finance-research-runner.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";
import { buildFinanceThesisDecisionContext } from "./finance-thesis-decision-context.js";
import {
  FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
  FINANCE_INTRADAY_QUOTE_APPROVAL_POLICY,
  FINANCE_TRADE_DECISION_REVIEW_TIMEOUT_MS,
  isValidFinanceTradeDecisionReviewResult,
  type FinanceIntradayTradeDecisionReviewRequest,
  type FinanceTradeDecisionReviewResult,
  type FinanceTradeDecisionReviewer,
} from "./finance-trade-decision-review.js";

type Controller = Required<
  Pick<
    FinanceDailyCycleParams,
    "accountId" | "accountBookProvider" | "executionQuoteProvider" | "createSafetyContext"
  >
> & { prepareExecutionQuote?: Controller["executionQuoteProvider"] };

// Race only preparation reads, never a venue dispatch or its durable receipt.
// Providers that ignore cancellation may finish later; their result cannot resume execution.
class PreparationDeadlineError extends Error {
  constructor() {
    super("intraday preparation deadline exceeded");
  }
}

function waitForPreparation<T>(
  caller: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([caller, deadline]);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(
        caller.aborted
          ? new Error("intraday preparation cancelled")
          : new PreparationDeadlineError(),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      void read(signal).then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
            onAbort();
          } else {
            resolve(value);
          }
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    }
  });
}

function reviewedQuoteComparison(
  review: FinanceIntradayDecisionReviewReceipt,
  quote: FinanceDailyCycleExecutionQuote,
): { status: "unchanged" | "inside_reviewed_bid_ask" } | { status: "refused"; reason: string } {
  const reviewed = review.request.candidates[0].executionQuote;
  if (
    quote.sourceUrlOrArtifact !== reviewed.sourceUrlOrArtifact ||
    quote.feed !== reviewed.feed ||
    quote.priceBasis !== reviewed.priceBasis ||
    quote.maxAgeMs !== reviewed.maxAgeMs ||
    Date.parse(quote.referencePriceAt) < Date.parse(reviewed.referencePriceAt)
  ) {
    return {
      status: "refused",
      reason: "intraday reviewed quote provenance or age policy changed",
    };
  }
  if (quote.bidPrice === reviewed.bidPrice && quote.askPrice === reviewed.askPrice) {
    return { status: "unchanged" };
  }
  // Only a reviewer that declared this scope can approve an improved refresh.
  // No price tolerance or authority is inferred for legacy review receipts.
  if (
    review.quoteApprovalPolicy === FINANCE_INTRADAY_QUOTE_APPROVAL_POLICY &&
    reviewed.bidPrice !== undefined &&
    reviewed.askPrice !== undefined &&
    quote.bidPrice !== undefined &&
    quote.askPrice !== undefined &&
    quote.bidPrice >= reviewed.bidPrice &&
    quote.askPrice <= reviewed.askPrice
  ) {
    return { status: "inside_reviewed_bid_ask" };
  }
  return {
    status: "refused",
    reason: "intraday reviewed execution prices changed; a new model review is required",
  };
}

function reviewQuoteSnapshot(quote: FinanceDailyCycleExecutionQuote, asOfMs: number) {
  return {
    referencePrice: quote.referencePrice,
    referencePriceAt: quote.referencePriceAt,
    ...(quote.bidPrice === undefined ? {} : { bidPrice: quote.bidPrice }),
    ...(quote.askPrice === undefined ? {} : { askPrice: quote.askPrice }),
    ...(quote.feed === undefined ? {} : { feed: quote.feed }),
    ...(quote.priceBasis === undefined ? {} : { priceBasis: quote.priceBasis }),
    sourceUrlOrArtifact: quote.sourceUrlOrArtifact,
    ageMs: asOfMs - Date.parse(quote.referencePriceAt),
    maxAgeMs: quote.maxAgeMs,
  };
}

async function managedDynamicExitProofIssue(
  directory: string,
  decision: FinanceIntradayDecisionRecord,
  accountId: string,
  contract: FinanceIntradayActiveRuleContract,
): Promise<string | null> {
  const binding = decision.input.strategyBinding;
  const proof = binding?.managedExitProof;
  if (!proof) {
    return "dynamic-universe exit is missing its managed-position proof";
  }
  if (
    contract.paperUniverseScope !== "fresh_us_equity_selection_v1" ||
    decision.input.action !== "sell" ||
    !["opening_range_stop", "reward_target", "pre_close"].includes(decision.input.reason) ||
    proof.accountId !== accountId ||
    proof.positionQuantity <= 0
  ) {
    return "dynamic-universe exit proof is outside the opted-in Paper exit contract";
  }
  const decisions = await readFinanceIntradayDecisions(directory, {
    instrument: decision.input.instrument,
  });
  const entry = decisions.find((record) => record.ref === proof.entryDecisionRef);
  if (
    !entry ||
    entry.input.action !== "buy" ||
    entry.input.instrument !== decision.input.instrument ||
    entry.input.strategyRule !== contract.ruleId ||
    entry.input.strategyBinding?.scope !== "system_universe" ||
    entry.input.strategyBinding.declarationRef !== contract.declarationRef ||
    entry.input.strategyBinding.activationRef !== contract.activationRef
  ) {
    return "dynamic-universe exit entry decision is not bound to the active strategy activation";
  }
  const positionRecords = await readFinancePositionRecords(directory);
  const entryReceipt = positionRecords.receipts.find(
    (receipt) => receipt.receiptId === proof.entryReceiptId,
  );
  if (
    !entryReceipt ||
    entryReceipt.adapterKind !== "venue" ||
    entryReceipt.venue !== "alpaca:paper" ||
    entryReceipt.accountId !== accountId ||
    entryReceipt.instrument !== decision.input.instrument ||
    entryReceipt.intentId !== `intent:${entry.input.signalId}` ||
    entryReceipt.side !== "buy" ||
    entryReceipt.fill.filledQuantity <= 0 ||
    entryReceipt.fill.terminalOrderIdentity?.terminal !== true ||
    !entryReceipt.fill.terminalOrderIdentity.orderId.trim()
  ) {
    return "dynamic-universe exit lacks its same-account terminal Paper entry receipt";
  }
  const ownedActions = new Map(
    decisions
      .filter(
        (record) =>
          record.input.strategyRule === contract.ruleId &&
          record.input.strategyBinding?.declarationRef === contract.declarationRef &&
          record.input.strategyBinding?.activationRef === contract.activationRef,
      )
      .map((record) => [record.input.signalId, record.input.action] as const),
  );
  const boundReceipts = positionRecords.receipts.filter(
    (receipt) =>
      receipt.adapterKind === "venue" &&
      receipt.venue === "alpaca:paper" &&
      receipt.accountId === accountId &&
      receipt.instrument === decision.input.instrument &&
      receipt.intentId.startsWith("intent:") &&
      receipt.fill.filledQuantity > 0 &&
      receipt.fill.terminalOrderIdentity?.terminal === true &&
      ownedActions.get(receipt.intentId.slice("intent:".length)) === receipt.side,
  );
  const book = await readFinanceIntradayOwnedPositions({
    directory,
    accountId,
    receipts: boundReceipts,
  });
  const currentQuantity =
    book.positions.find((position) => position.instrument === decision.input.instrument)
      ?.quantity ?? 0;
  if (
    !Number.isFinite(currentQuantity) ||
    currentQuantity <= 0 ||
    Math.abs(currentQuantity - proof.positionQuantity) > 1e-6
  ) {
    return "dynamic-universe exit proof does not match the canonical current owned quantity";
  }
  return null;
}

async function strategyBindingIssue(
  directory: string,
  decision: FinanceIntradayDecisionRecord,
  asOf: string,
  accountId: string,
): Promise<string | null> {
  const binding = decision.input.strategyBinding;
  if (!binding) {
    return "legacy intraday decision has no active-strategy provenance";
  }
  if (binding.scope === "explicit_diagnostic") {
    return "diagnostic ticker override cannot authorize Paper placement";
  }
  if (
    binding.scope === "managed_position_exit" &&
    (decision.input.action !== "sell" || binding.managedExitProof === undefined)
  ) {
    return "managed-position scope only authorizes a proven existing-position exit";
  }
  const marketSession = binding.marketSession;
  if (!marketSession || marketSession.date !== decision.input.sessionDate) {
    return "intraday decision is missing its bound market-calendar session";
  }
  const marketSessionIssue = financeAlpacaMarketSessionIssue(marketSession, {
    asOf,
    maxObservedAgeMs: 5 * 60_000,
  });
  if (
    marketSessionIssue !== null ||
    Date.parse(asOf) < Date.parse(marketSession.openAt) ||
    Date.parse(asOf) >= Date.parse(marketSession.closeAt) ||
    Date.parse(decision.input.referencePriceAt) < Date.parse(marketSession.openAt) ||
    Date.parse(decision.input.referencePriceAt) >= Date.parse(marketSession.closeAt)
  ) {
    return marketSessionIssue ?? "intraday decision is outside its bound market-calendar session";
  }
  const { ledger } = await readFinanceStrategyRuleLedger(directory);
  const retiredExit =
    decision.input.action === "sell" &&
    ["opening_range_stop", "reward_target", "pre_close"].includes(decision.input.reason) &&
    ledger.rules.some(
      (rule) => rule.ruleId === decision.input.strategyRule && rule.state === "retired",
    );
  const matching = ledger.rules.filter(
    (rule) =>
      rule.form === FINANCE_INTRADAY_OPENING_RANGE_FORM &&
      (retiredExit
        ? rule.ruleId === decision.input.strategyRule && rule.state === "retired"
        : rule.state === "active"),
  );
  if (matching.length !== 1 || matching[0]?.ruleId !== decision.input.strategyRule) {
    return "intraday strategy is missing, ambiguous, or no longer active";
  }
  let contract;
  try {
    contract = resolveFinanceIntradayActiveRuleContract(matching[0], {
      allowRetiredExit: retiredExit,
    });
  } catch (error) {
    return error instanceof Error ? error.message : "intraday strategy contract is incompatible";
  }
  if (
    binding.declarationRef !== contract.declarationRef ||
    binding.activationRef !== contract.activationRef ||
    JSON.stringify([...binding.declaredInstruments].toSorted()) !==
      JSON.stringify([...contract.instruments].toSorted()) ||
    binding.parameters.openingRangeBars !== contract.openingRangeBars ||
    binding.parameters.rewardRisk !== contract.rewardRisk ||
    binding.parameters.intervalSeconds !== contract.intervalSeconds ||
    binding.parameters.feed !== contract.feed
  ) {
    return "intraday signal provenance does not match the currently active strategy contract";
  }
  if (!contract.eligibility.automatedPaperPlacementAllowed) {
    return `intraday strategy eligibility blocks Paper placement: ${contract.eligibility.status}`;
  }
  const managedDynamicExit = binding.managedExitProof !== undefined;
  const dynamicSystemScope =
    binding.scope === "system_universe" &&
    contract.paperUniverseScope === "fresh_us_equity_selection_v1";
  if (
    contract.paperUniverseScope === "fresh_us_equity_selection_v1" &&
    !dynamicSystemScope &&
    !managedDynamicExit
  ) {
    return "dynamic-universe placement requires a fresh selected scope or a proven managed exit";
  }
  if (
    !contract.instruments.includes(decision.input.instrument.toUpperCase()) &&
    !managedDynamicExit &&
    !dynamicSystemScope
  ) {
    return "intraday signal instrument is outside the active strategy execution scope";
  }
  if (managedDynamicExit) {
    if (retiredExit && contract.paperUniverseScope !== "fresh_us_equity_selection_v1") {
      return "retired exits use the existing retired-strategy proof path";
    }
    const issue = await managedDynamicExitProofIssue(directory, decision, accountId, contract);
    if (issue) {
      return issue;
    }
  }
  if (retiredExit) {
    const records = await readFinancePositionRecords(directory);
    const decisions = await readFinanceIntradayDecisions(directory, {
      instrument: decision.input.instrument,
    });
    const receipts = receiptsForIntradayStrategy(records.receipts, accountId).filter(
      (receipt) => receipt.instrument === decision.input.instrument,
    );
    const boundReceipts = receipts.filter((receipt) =>
      decisions.some(
        (record) =>
          `intent:${record.input.signalId}` === receipt.intentId &&
          record.input.action === receipt.side &&
          record.input.strategyRule === decision.input.strategyRule &&
          record.input.strategyBinding?.declarationRef === binding.declarationRef &&
          record.input.strategyBinding?.activationRef === binding.activationRef &&
          record.input.strategyBinding?.scope !== "explicit_diagnostic",
      ),
    );
    const net = async (items: typeof receipts) =>
      (
        await readFinanceIntradayOwnedPositions({ directory, accountId, receipts: items })
      ).positions.find((position) => position.instrument === decision.input.instrument)?.quantity ??
      0;
    const owned = await net(boundReceipts);
    if (owned <= 0 || owned !== (await net(receipts))) {
      return "retired strategy exit lacks unambiguous account-bound entry ownership";
    }
    // Retirement removes entry authority, not the obligation to close proven inventory.
    // The original declaration, session, quote, broker holding and execution gates still apply.
    return null;
  }
  if (binding.scope === "strategy_universe" && binding.universeSnapshotRef !== undefined) {
    return "strategy-universe decision unexpectedly carries a system snapshot reference";
  }
  if (binding.scope === "system_universe" && !binding.universeSnapshotRef) {
    return "system-universe decision is missing its validated snapshot reference";
  }
  if (binding.scope === "system_universe") {
    try {
      const snapshot = readFinanceResearchEquityUniverseSnapshot(directory, asOf);
      if (
        caseflowFingerprint(snapshot) !== binding.universeSnapshotRef ||
        (!snapshot.selected.includes(decision.input.instrument.toUpperCase()) &&
          !managedDynamicExit)
      ) {
        return "system-universe signal no longer matches the current validated snapshot";
      }
    } catch {
      return "system-universe snapshot is missing, stale, or invalid";
    }
  }
  return null;
}

export async function executeFinanceIntradayDecision(params: {
  directory: string;
  decision: FinanceIntradayDecisionRecord;
  controller: Controller;
  caps: { maxOrderNotional: number; maxInstrumentNotional: number; maxOrdersPerRun: number };
  tradeDecisionReviewer?: FinanceTradeDecisionReviewer;
  signal?: AbortSignal;
  now?: () => number;
  runOrder?: typeof runFinanceAlpacaOrder;
  recordFill?: typeof recordCycleFill;
}) {
  const prior = await readFinanceIntradayOutcome(params.directory, params.decision.input.signalId);
  if (prior) {
    return Object.freeze({ status: "already_terminal" as const, outcome: prior });
  }
  const input = params.decision.input;
  // A supplied caller owns the total budget. Only the legacy default is a total deadline.
  const signal = params.signal ?? AbortSignal.timeout(120_000);
  const startedAt = performance.now();
  let stage: NonNullable<FinanceIntradayOutcomeInput["executionFailure"]>["stage"] =
    "position_receipts";
  const executionFailure = (
    error?: unknown,
  ): NonNullable<FinanceIntradayOutcomeInput["executionFailure"]> => ({
    stage,
    category: params.signal?.aborted
      ? "cancelled"
      : signal.aborted || error instanceof PreparationDeadlineError
        ? "deadline_exceeded"
        : "unexpected",
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
  });
  const now = params.now ?? Date.now;
  let tradeDecisionReview: FinanceIntradayDecisionReviewReceipt | undefined;
  try {
    // Recovery takes precedence over cancellation: never hide a durable placed receipt.
    const positionRecords = await readFinancePositionRecords(params.directory);
    const recoveredReceipt = positionRecords.receipts.find(
      (receipt) =>
        receipt.intentId === `intent:${input.signalId}` &&
        receipt.adapterKind === "venue" &&
        receipt.venue === "alpaca:paper" &&
        receipt.accountId === params.controller.accountId,
    );
    if (recoveredReceipt) {
      const outcome = await appendFinanceIntradayOutcome(params.directory, {
        signalId: input.signalId,
        status: "placed",
        receiptId: recoveredReceipt.receiptId,
        reasons: ["recovered from durable execution receipt"],
      });
      return Object.freeze({
        status: "recovered_placed" as const,
        outcome: outcome.input,
        receipt: recoveredReceipt,
      });
    }
    stage = "safety_claims";
    const safetyClaims = await waitForPreparation(signal, (signal) =>
      readFinanceExecutionSafetyClaims({
        stateDir: params.directory,
        accountId: params.controller.accountId,
        venue: "alpaca:paper",
        signal,
      }),
    );
    if (safetyClaims.some((claim) => claim.status === "reserved" || claim.status === "unknown")) {
      const outcome = await appendFinanceIntradayOutcome(params.directory, {
        signalId: input.signalId,
        status: "refused",
        reasons: ["account_execution_safety_claim_pending_before_model_review"],
      });
      return Object.freeze({ status: "refused" as const, outcome: outcome.input });
    }
    stage = "strategy_binding";
    const strategyIssue = await waitForPreparation(signal, () =>
      strategyBindingIssue(
        params.directory,
        params.decision,
        new Date(now()).toISOString(),
        params.controller.accountId,
      ),
    );
    if (strategyIssue) {
      const outcome = await appendFinanceIntradayOutcome(params.directory, {
        signalId: input.signalId,
        status: "refused",
        reasons: [strategyIssue],
      });
      return Object.freeze({ status: "refused" as const, outcome: outcome.input });
    }
    stage = "account_book";
    const account = await waitForPreparation(signal, (signal) =>
      params.controller.accountBookProvider(signal),
    );
    const reconciliation = account.reconciliation;
    if (
      reconciliation?.status === "blocked" ||
      (reconciliation?.status === "restricted" &&
        reconciliation.quarantinedInstruments.includes(input.instrument.toUpperCase()))
    ) {
      const outcome = await appendFinanceIntradayOutcome(params.directory, {
        signalId: input.signalId,
        status: "refused",
        reasons: [
          reconciliation.status === "blocked"
            ? "broker reconciliation blocked before model review"
            : "instrument is quarantined by broker reconciliation before model review",
        ],
      });
      return Object.freeze({ status: "refused" as const, outcome: outcome.input });
    }
    const brokerHeld =
      account.positions.find((position) => position.instrument === input.instrument)?.quantity ?? 0;
    stage = "owned_positions";
    const ownedBook = await waitForPreparation(signal, () =>
      readFinanceIntradayOwnedPositions({
        directory: params.directory,
        accountId: params.controller.accountId,
        instrument: input.instrument,
        receipts: positionRecords.receipts,
      }),
    );
    const owned =
      ownedBook.positions.find((position) => position.instrument === input.instrument)?.quantity ??
      0;
    const sellQuantity = input.strategyBinding?.managedExitProof?.positionQuantity ?? owned;
    const positionRefused =
      (input.action === "buy" && owned !== 0) ||
      (input.action === "sell" &&
        (sellQuantity <= 0 || sellQuantity > owned || sellQuantity > brokerHeld));
    if (positionRefused) {
      const outcome = await appendFinanceIntradayOutcome(params.directory, {
        signalId: input.signalId,
        status: "refused",
        reasons: [
          `position gate refused ${input.action}: intraday-owned quantity ${owned}, ` +
            `broker-total quantity ${brokerHeld}`,
        ],
      });
      return Object.freeze({ status: "refused" as const, outcome: outcome.input });
    }
    stage = "initial_quote";
    let quote = {
      ...(await waitForPreparation(signal, (signal) =>
        params.controller.executionQuoteProvider(
          { instrument: input.instrument, assetClass: "us_equity", side: input.action },
          signal,
        ),
      )),
    };
    let referencePrice = input.action === "buy" ? quote.askPrice : quote.bidPrice;
    if (referencePrice === undefined || !Number.isFinite(referencePrice) || referencePrice <= 0) {
      throw new Error("intraday execution requires a side-specific live quote");
    }
    const observedAtMs = now();
    const quoteIssue = executionQuoteIssue(quote, observedAtMs);
    if (quoteIssue !== null) {
      const outcome = await appendFinanceIntradayOutcome(params.directory, {
        signalId: input.signalId,
        status: "refused",
        reasons: [`execution quote gate refused model review: ${quoteIssue}`],
      });
      return Object.freeze({ status: "refused" as const, outcome: outcome.input });
    }
    const orderRequest = (price: number): FinanceAlpacaRunRequest => ({
      credentialStateDirectory: params.directory,
      createSafetyContext: params.controller.createSafetyContext,
      conclusion: {
        conclusionId: input.signalId,
        decisionRef: { source: "intraday_signal", id: input.signalId },
        instrument: input.instrument,
        direction: input.action,
        conviction: 1,
        assetClass: "us_equity",
        horizonDays: 1,
        thesis: `${input.strategyRule}: ${input.reason}; dataset ${input.datasetHeadRef}`,
        ...(input.action === "buy" && input.stopPrice !== undefined
          ? {
              invalidationPrice: input.stopPrice,
              targetPrice: input.targetPrice,
              ...(input.strategyBinding?.priceNormalization
                ? { priceNormalization: input.strategyBinding.priceNormalization }
                : {}),
            }
          : {}),
      },
      market: { referencePrice: price, referencePriceAt: quote.referencePriceAt },
      equity: account.equity,
      ...(input.action === "buy"
        ? {
            committedInstrumentNotional: Math.max(
              Math.abs(
                account.positions.find((position) => position.instrument === input.instrument)
                  ?.marketValue ?? 0,
              ),
              Math.abs(brokerHeld * price),
            ),
          }
        : {}),
      runAuthorizationId: `intraday-paper:${input.sessionDate}:${input.signalId}`,
      budget: {
        automation: "unattended",
        allowedInstruments: [input.instrument],
        ...params.caps,
      },
      instruments: [input.instrument],
      strategyClass: "A",
      ...(input.action === "sell" ? { quantityOverride: sellQuantity } : {}),
      mode: "paper",
      signal,
    });
    // Reject known sizing/price contradictions before spending on discretionary review.
    // The venue path recompiles with the final quote and still owns all safety reservations.
    const preflight = compileFinanceAlpacaOrderIntent(orderRequest(referencePrice));
    if (!preflight.ok) {
      const outcome = await appendFinanceIntradayOutcome(params.directory, {
        signalId: input.signalId,
        status: "refused",
        reasons: [...preflight.refusals],
      });
      return Object.freeze({ status: "refused" as const, outcome: outcome.input });
    }
    // Only strategy-bound, owned-position reductions bypass discretionary model review.
    const protectiveExit =
      input.action === "sell" &&
      ["opening_range_stop", "reward_target", "pre_close"].includes(input.reason);
    if (!protectiveExit) {
      const reconciliation = account.reconciliation;
      stage = "decision_context";
      const decisionContext = await waitForPreparation(signal, () =>
        buildFinanceThesisDecisionContext({
          directory: params.directory,
          asOf: new Date(observedAtMs).toISOString(),
          instruments: [input.instrument],
          horizon: "intraday",
        }),
      );
      const reviewRequest: FinanceIntradayTradeDecisionReviewRequest = {
        schemaVersion: FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
        venue: "alpaca:paper",
        asOf: new Date(observedAtMs).toISOString(),
        signalAnchor: input.signalId,
        ruleIds: [input.strategyRule],
        equity: account.equity,
        caps: params.caps,
        positionBookObservedAt: account.observedAt,
        reconciliation: {
          status: reconciliation?.status ?? "unverified",
          ...(reconciliation
            ? {
                historyStatus: reconciliation.historyStatus,
                uncertaintyReserve: reconciliation.uncertaintyReserve,
                quarantinedInstruments: reconciliation.quarantinedInstruments,
              }
            : {}),
        },
        positions: account.positions,
        decisionContext,
        candidates: [
          {
            candidateId: input.signalId,
            instrument: input.instrument,
            side: input.action,
            strategyRule: input.strategyRule,
            signalReason: input.reason,
            signalReferencePrice: input.referencePrice,
            signalReferencePriceAt: input.referencePriceAt,
            ...(input.stopPrice === undefined ? {} : { stopPrice: input.stopPrice }),
            ...(input.targetPrice === undefined ? {} : { targetPrice: input.targetPrice }),
            datasetHeadRef: input.datasetHeadRef,
            marketSession: input.strategyBinding!.marketSession!,
            intradayOwnedQuantity: owned,
            brokerPositionQuantity: brokerHeld,
            executionQuote: reviewQuoteSnapshot(quote, observedAtMs),
          },
        ],
      };
      const reviewStartedAt = now();
      const failedReview = (
        failureCode:
          | "reviewer_unavailable"
          | "output_invalid"
          | "runtime_timeout"
          | "process_error",
        attempted: boolean,
      ): FinanceTradeDecisionReviewResult => ({
        status: "failed" as const,
        attempted,
        provider: "unavailable",
        modelId: "unavailable",
        latencyMs: attempted ? Math.max(0, now() - reviewStartedAt) : 0,
        providerCallObserved: false,
        adapterAttested: false,
        failureCode,
      });
      stage = "model_review";
      let rawReview: unknown;
      if (!params.tradeDecisionReviewer) {
        rawReview = failedReview("reviewer_unavailable", false);
      } else {
        try {
          rawReview = await waitForPreparation(
            signal,
            (reviewSignal) =>
              params.tradeDecisionReviewer!(
                reviewRequest,
                AbortSignal.any([
                  reviewSignal,
                  AbortSignal.timeout(FINANCE_TRADE_DECISION_REVIEW_TIMEOUT_MS),
                ]),
              ),
            FINANCE_TRADE_DECISION_REVIEW_TIMEOUT_MS + 5_000,
          );
        } catch (error) {
          rawReview = failedReview(
            error instanceof PreparationDeadlineError ||
              signal.aborted ||
              (error instanceof Error && error.message === "timeout")
              ? "runtime_timeout"
              : "process_error",
            true,
          );
        }
      }
      let reviewContractAnomaly = false;
      let reviewResult: FinanceTradeDecisionReviewResult;
      if (isValidFinanceTradeDecisionReviewResult(rawReview, reviewRequest)) {
        reviewResult = rawReview;
      } else {
        reviewContractAnomaly =
          rawReview !== null &&
          typeof rawReview === "object" &&
          "status" in rawReview &&
          rawReview.status === "completed";
        reviewResult = failedReview("output_invalid", true);
      }
      const reviewedDecision =
        reviewResult.status === "completed" ? reviewResult.decisions?.[0] : undefined;
      tradeDecisionReview = FinanceIntradayDecisionReviewReceiptSchema.parse({
        request: reviewRequest,
        status: reviewResult.status,
        attempted: reviewResult.attempted,
        modelCalls: reviewResult.modelCalls ?? (reviewResult.attempted ? 1 : 0),
        provider: reviewResult.provider,
        modelId: reviewResult.modelId,
        latencyMs: reviewResult.latencyMs,
        providerCallObserved: reviewResult.providerCallObserved,
        adapterAttested: reviewResult.adapterAttested,
        ...(reviewResult.quoteApprovalPolicy
          ? { quoteApprovalPolicy: reviewResult.quoteApprovalPolicy }
          : {}),
        ...(reviewResult.requestIdSha256 ? { requestIdSha256: reviewResult.requestIdSha256 } : {}),
        ...(reviewResult.toolEvidence ? { toolEvidence: reviewResult.toolEvidence } : {}),
        ...(reviewResult.modelCallEvidence
          ? { modelCallEvidence: reviewResult.modelCallEvidence }
          : {}),
        ...(reviewResult.taskObjectiveSha256
          ? { taskObjectiveSha256: reviewResult.taskObjectiveSha256 }
          : {}),
        ...(reviewedDecision ? { decision: reviewedDecision } : {}),
        ...(reviewResult.status === "failed"
          ? { failureCode: reviewResult.failureCode ?? "output_invalid" }
          : {}),
      });
      if (
        reviewContractAnomaly ||
        (reviewResult.status === "completed" && !reviewedDecision) ||
        signal.aborted
      ) {
        const outcome = await appendFinanceIntradayOutcome(params.directory, {
          signalId: input.signalId,
          status: "refused",
          reasons: [
            reviewContractAnomaly || (reviewResult.status === "completed" && !reviewedDecision)
              ? "completed intraday model review violated candidate binding; refusing paper placement"
              : "intraday decision was cancelled before execution",
          ],
          tradeDecisionReview,
          ...(signal.aborted ? { executionFailure: executionFailure() } : {}),
        });
        return Object.freeze({
          status: "refused" as const,
          outcome: outcome.input,
          tradeDecisionReview,
        });
      }
      if (reviewedDecision?.decision === "veto") {
        const outcome = await appendFinanceIntradayOutcome(params.directory, {
          signalId: input.signalId,
          status: "refused",
          reasons: [`intraday model veto: ${reviewedDecision.rationale}`],
          tradeDecisionReview,
        });
        return Object.freeze({
          status: "refused" as const,
          outcome: outcome.input,
          tradeDecisionReview,
        });
      }
    }
    if (signal.aborted) {
      throw new Error("intraday decision was cancelled before execution");
    }
    const reviewedQuote = quote;
    // Model review and ledger reads can outlive the quote; refresh once, then fail closed.
    if (params.controller.prepareExecutionQuote || executionQuoteIssue(quote, now()) !== null) {
      stage = "refresh_quote";
      quote = {
        ...(await waitForPreparation(signal, (signal) =>
          (params.controller.prepareExecutionQuote ?? params.controller.executionQuoteProvider)(
            { instrument: input.instrument, assetClass: "us_equity", side: input.action },
            signal,
          ),
        )),
      };
    }
    const checkedAtMs = now();
    const finalQuoteIssue = executionQuoteIssue(quote, checkedAtMs);
    referencePrice = input.action === "buy" ? quote.askPrice : quote.bidPrice;
    if (
      finalQuoteIssue !== null ||
      referencePrice === undefined ||
      !Number.isFinite(referencePrice) ||
      referencePrice <= 0
    ) {
      const outcome = await appendFinanceIntradayOutcome(params.directory, {
        signalId: input.signalId,
        status: "refused",
        reasons: [`intraday execution quote refused: ${finalQuoteIssue ?? "missing side price"}`],
        ...(tradeDecisionReview ? { tradeDecisionReview } : {}),
      });
      return Object.freeze({
        status: "refused" as const,
        outcome: outcome.input,
        ...(tradeDecisionReview ? { tradeDecisionReview } : {}),
      });
    }
    if (!protectiveExit && tradeDecisionReview?.status === "completed") {
      const comparison = reviewedQuoteComparison(tradeDecisionReview, quote);
      tradeDecisionReview = FinanceIntradayDecisionReviewReceiptSchema.parse({
        ...tradeDecisionReview,
        executionQuoteValidation: {
          policy: tradeDecisionReview.quoteApprovalPolicy ?? "exact",
          checkedAt: new Date(checkedAtMs).toISOString(),
          ...comparison,
          quote: reviewQuoteSnapshot(quote, checkedAtMs),
        },
      });
      if (comparison.status === "refused") {
        const outcome = await appendFinanceIntradayOutcome(params.directory, {
          signalId: input.signalId,
          status: "refused",
          reasons: [comparison.reason],
          tradeDecisionReview,
        });
        return Object.freeze({
          status: "refused" as const,
          outcome: outcome.input,
          tradeDecisionReview,
        });
      }
    }
    if (
      referencePrice !== (input.action === "buy" ? reviewedQuote.askPrice : reviewedQuote.bidPrice)
    ) {
      const finalPreflight = compileFinanceAlpacaOrderIntent(orderRequest(referencePrice));
      if (!finalPreflight.ok) {
        const outcome = await appendFinanceIntradayOutcome(params.directory, {
          signalId: input.signalId,
          status: "refused",
          reasons: [...finalPreflight.refusals],
          tradeDecisionReview,
        });
        return Object.freeze({
          status: "refused" as const,
          outcome: outcome.input,
          tradeDecisionReview,
        });
      }
    }
    stage = "final_strategy_binding";
    const finalCalendarIssue = await waitForPreparation(signal, () =>
      strategyBindingIssue(
        params.directory,
        params.decision,
        new Date(now()).toISOString(),
        params.controller.accountId,
      ),
    );
    if (finalCalendarIssue) {
      const outcome = await appendFinanceIntradayOutcome(params.directory, {
        signalId: input.signalId,
        status: "refused",
        reasons: [finalCalendarIssue],
        tradeDecisionReview,
      });
      return Object.freeze({
        status: "refused" as const,
        outcome: outcome.input,
        tradeDecisionReview,
      });
    }
    signal.throwIfAborted();
    stage = "order_dispatch";
    const result = await (params.runOrder ?? runFinanceAlpacaOrder)(orderRequest(referencePrice));
    if (!result.ok) {
      const outcome = await appendFinanceIntradayOutcome(params.directory, {
        signalId: input.signalId,
        status: "refused",
        reasons: [...result.refusals],
        ...(result.safetyFailure ? { executionSafetyFailure: result.safetyFailure } : {}),
        tradeDecisionReview,
      });
      return Object.freeze({
        status: "refused" as const,
        outcome: outcome.input,
        tradeDecisionReview,
      });
    }
    stage = "fill_projection";
    const recorded = await (params.recordFill ?? recordCycleFill)({
      directory: params.directory,
      receipt: result.receipt,
    });
    if (!recorded.recorded || !recorded.marked || recorded.refusal) {
      const outcome = await appendFinanceIntradayOutcome(params.directory, {
        signalId: input.signalId,
        status: "uncertain",
        reasons: [recorded.refusal ?? "fill did not reach a complete local ledger projection"],
        tradeDecisionReview,
      });
      return Object.freeze({
        status: "uncertain" as const,
        outcome: outcome.input,
        tradeDecisionReview,
      });
    }
    const outcome = await appendFinanceIntradayOutcome(params.directory, {
      signalId: input.signalId,
      status: "placed",
      receiptId: result.receipt.receiptId,
      reasons: protectiveExit
        ? ["strategy-owned protective exit; discretionary model review bypassed"]
        : [],
      tradeDecisionReview,
    });
    return Object.freeze({
      status: "placed" as const,
      outcome: outcome.input,
      receipt: result.receipt,
      ledger: recorded,
      tradeDecisionReview,
    });
  } catch (error) {
    const uncertain = error instanceof FinanceExecutionSafetyUncertainError;
    const terminalFailure = error instanceof FinanceExecutionSafetyTerminalFailureError;
    const attempt = uncertain || terminalFailure ? error.attempt : undefined;
    const factsFailure =
      error instanceof FinanceExecutionSafetyFactsError
        ? {
            stage: "facts" as const,
            category: error.category,
            operation: "read_account_safety_facts" as const,
            ...(error.provider ? { provider: { ...error.provider } } : {}),
          }
        : undefined;
    const outcome = await appendFinanceIntradayOutcome(params.directory, {
      signalId: input.signalId,
      status: uncertain ? "uncertain" : "refused",
      reasons: [
        attempt
          ? attempt.disposition === "not_started"
            ? "execution_dispatch_not_started"
            : attempt.disposition === "definite_rejection"
              ? "execution_venue_rejected"
              : "execution_outcome_unresolved"
          : factsFailure
            ? `execution_safety_${factsFailure.category}`
            : "intraday_execution_unexpected_error",
      ],
      ...(!factsFailure && !attempt ? { executionFailure: executionFailure(error) } : {}),
      ...(factsFailure ? { executionSafetyFailure: factsFailure } : {}),
      ...(attempt
        ? {
            executionSafetyFailure: {
              stage:
                attempt.phase === "not_started"
                  ? ("reservation" as const)
                  : attempt.phase === "receipt"
                    ? ("receipt" as const)
                    : ("execution" as const),
              category: "unexpected" as const,
              operation:
                attempt.phase === "not_started"
                  ? ("reserve_execution_claim" as const)
                  : attempt.phase === "receipt"
                    ? ("record_execution_receipt" as const)
                    : ("execute_order" as const),
              attempt,
            },
          }
        : {}),
      ...(tradeDecisionReview ? { tradeDecisionReview } : {}),
    });
    return Object.freeze({
      status: uncertain ? ("uncertain" as const) : ("refused" as const),
      outcome: outcome.input,
      ...(tradeDecisionReview ? { tradeDecisionReview } : {}),
    });
  }
}
