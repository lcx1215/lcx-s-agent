import { withTimeout } from "../utils/with-timeout.js";
import { financeAlpacaMarketSessionIssue } from "./finance-alpaca-market-calendar.js";
import { runFinanceAlpacaOrder } from "./finance-alpaca-run.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import {
  executionQuoteIssue,
  recordCycleFill,
  type FinanceDailyCycleParams,
} from "./finance-daily-cycle.js";
import {
  appendFinanceIntradayOutcome,
  FinanceIntradayDecisionReviewReceiptSchema,
  readFinanceIntradayOutcome,
  readFinanceIntradayDecisions,
  type FinanceIntradayDecisionRecord,
  type FinanceIntradayDecisionReviewReceipt,
} from "./finance-intraday-control-ledger.js";
import {
  FINANCE_INTRADAY_OPENING_RANGE_FORM,
  resolveFinanceIntradayActiveRuleContract,
} from "./finance-intraday-paper.js";
import { receiptsForIntradayStrategy } from "./finance-intraday-position.js";
import { projectFinancePositions, readFinancePositionRecords } from "./finance-position-ledger.js";
import { readFinanceResearchEquityUniverseSnapshot } from "./finance-research-runner.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";
import { buildFinanceThesisDecisionContext } from "./finance-thesis-decision-context.js";
import {
  FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
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
>;

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
  if (!contract.instruments.includes(decision.input.instrument.toUpperCase())) {
    return "intraday signal instrument is outside the active strategy execution scope";
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
    const net = (items: typeof receipts) =>
      projectFinancePositions({ receipts: items }).positions.find(
        (position) => position.instrument === decision.input.instrument,
      )?.quantity ?? 0;
    const owned = net(boundReceipts);
    if (owned <= 0 || owned !== net(receipts)) {
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
        !snapshot.selected.includes(decision.input.instrument.toUpperCase())
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
  const signal = params.signal ?? AbortSignal.timeout(120_000);
  const now = params.now ?? Date.now;
  let tradeDecisionReview: FinanceIntradayDecisionReviewReceipt | undefined;
  try {
    const positionRecords = await readFinancePositionRecords(params.directory);
    const recoveredReceipt = positionRecords.receipts.find(
      (receipt) =>
        receipt.intentId === `intent:${input.signalId}` &&
        receipt.adapterKind === "venue" &&
        receipt.venue.startsWith("alpaca") &&
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
    const strategyIssue = await strategyBindingIssue(
      params.directory,
      params.decision,
      new Date(now()).toISOString(),
      params.controller.accountId,
    );
    if (strategyIssue) {
      const outcome = await appendFinanceIntradayOutcome(params.directory, {
        signalId: input.signalId,
        status: "refused",
        reasons: [strategyIssue],
      });
      return Object.freeze({ status: "refused" as const, outcome: outcome.input });
    }
    const account = await params.controller.accountBookProvider(signal);
    const brokerHeld =
      account.positions.find((position) => position.instrument === input.instrument)?.quantity ?? 0;
    const owned =
      projectFinancePositions({
        receipts: receiptsForIntradayStrategy(
          positionRecords.receipts,
          params.controller.accountId,
        ),
      }).positions.find((position) => position.instrument === input.instrument)?.quantity ?? 0;
    const positionRefused =
      (input.action === "buy" && owned !== 0) ||
      (input.action === "sell" && (owned <= 0 || owned > brokerHeld));
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
    let quote = await params.controller.executionQuoteProvider(
      { instrument: input.instrument, assetClass: "us_equity", side: input.action },
      signal,
    );
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
    // Only strategy-bound, owned-position reductions bypass discretionary model review.
    const protectiveExit =
      input.action === "sell" &&
      ["opening_range_stop", "reward_target", "pre_close"].includes(input.reason);
    if (!protectiveExit) {
      const reconciliation = account.reconciliation;
      const decisionContext = await buildFinanceThesisDecisionContext({
        directory: params.directory,
        asOf: new Date(observedAtMs).toISOString(),
        instruments: [input.instrument],
        horizon: "intraday",
      });
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
            executionQuote: {
              referencePrice: quote.referencePrice,
              referencePriceAt: quote.referencePriceAt,
              ...(quote.bidPrice === undefined ? {} : { bidPrice: quote.bidPrice }),
              ...(quote.askPrice === undefined ? {} : { askPrice: quote.askPrice }),
              ...(quote.feed === undefined ? {} : { feed: quote.feed }),
              ...(quote.priceBasis === undefined ? {} : { priceBasis: quote.priceBasis }),
              sourceUrlOrArtifact: quote.sourceUrlOrArtifact,
              ageMs: observedAtMs - Date.parse(quote.referencePriceAt),
              maxAgeMs: quote.maxAgeMs,
            },
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
      let rawReview: unknown;
      if (!params.tradeDecisionReviewer) {
        rawReview = failedReview("reviewer_unavailable", false);
      } else {
        const reviewSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(FINANCE_TRADE_DECISION_REVIEW_TIMEOUT_MS),
        ]);
        try {
          rawReview = await withTimeout(
            params.tradeDecisionReviewer(reviewRequest, reviewSignal),
            FINANCE_TRADE_DECISION_REVIEW_TIMEOUT_MS + 5_000,
          );
        } catch (error) {
          rawReview = failedReview(
            error instanceof Error && error.message === "timeout"
              ? "runtime_timeout"
              : reviewSignal.aborted
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
        ...(reviewResult.requestIdSha256 ? { requestIdSha256: reviewResult.requestIdSha256 } : {}),
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
    // Model review and ledger reads can outlive the quote; refresh once, then fail closed.
    if (executionQuoteIssue(quote, now()) !== null) {
      quote = await params.controller.executionQuoteProvider(
        { instrument: input.instrument, assetClass: "us_equity", side: input.action },
        signal,
      );
    }
    const finalQuoteIssue = executionQuoteIssue(quote, now());
    referencePrice = input.action === "buy" ? quote.askPrice : quote.bidPrice;
    if (
      finalQuoteIssue !== null ||
      referencePrice === undefined ||
      !Number.isFinite(referencePrice) ||
      referencePrice <= 0
    ) {
      throw new Error(
        `intraday execution quote refused: ${finalQuoteIssue ?? "missing side price"}`,
      );
    }
    const finalCalendarIssue = await strategyBindingIssue(
      params.directory,
      params.decision,
      new Date(now()).toISOString(),
      params.controller.accountId,
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
    const result = await (params.runOrder ?? runFinanceAlpacaOrder)({
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
          ? { invalidationPrice: input.stopPrice, targetPrice: input.targetPrice }
          : {}),
      },
      market: { referencePrice, referencePriceAt: quote.referencePriceAt },
      equity: account.equity,
      ...(input.action === "buy"
        ? {
            committedInstrumentNotional: Math.max(
              Math.abs(
                account.positions.find((position) => position.instrument === input.instrument)
                  ?.marketValue ?? 0,
              ),
              Math.abs(brokerHeld * referencePrice),
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
      ...(input.action === "sell" ? { quantityOverride: owned } : {}),
      mode: "paper",
      signal,
    });
    if (!result.ok) {
      const outcome = await appendFinanceIntradayOutcome(params.directory, {
        signalId: input.signalId,
        status: "refused",
        reasons: [...result.refusals],
        tradeDecisionReview,
      });
      return Object.freeze({
        status: "refused" as const,
        outcome: outcome.input,
        tradeDecisionReview,
      });
    }
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
    const uncertain =
      error instanceof Error &&
      "code" in error &&
      error.code === "finance_execution_safety_unknown";
    const outcome = await appendFinanceIntradayOutcome(params.directory, {
      signalId: input.signalId,
      status: uncertain ? "uncertain" : "refused",
      reasons: [error instanceof Error ? error.message : String(error)],
      ...(tradeDecisionReview ? { tradeDecisionReview } : {}),
    });
    return Object.freeze({
      status: uncertain ? ("uncertain" as const) : ("refused" as const),
      outcome: outcome.input,
      ...(tradeDecisionReview ? { tradeDecisionReview } : {}),
    });
  }
}
