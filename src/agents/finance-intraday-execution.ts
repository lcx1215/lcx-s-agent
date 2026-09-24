import { withTimeout } from "../utils/with-timeout.js";
import { runFinanceAlpacaOrder } from "./finance-alpaca-run.js";
import {
  executionQuoteIssue,
  recordCycleFill,
  type FinanceDailyCycleParams,
} from "./finance-daily-cycle.js";
import {
  appendFinanceIntradayOutcome,
  FinanceIntradayDecisionReviewReceiptSchema,
  readFinanceIntradayOutcome,
  type FinanceIntradayDecisionRecord,
  type FinanceIntradayDecisionReviewReceipt,
} from "./finance-intraday-control-ledger.js";
import { receiptsForIntradayStrategy } from "./finance-intraday-position.js";
import { projectFinancePositions, readFinancePositionRecords } from "./finance-position-ledger.js";
import { buildFinanceThesisDecisionContext } from "./finance-thesis-decision-context.js";
import {
  FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
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
    const account = await params.controller.accountBookProvider(signal);
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
    const quote = await params.controller.executionQuoteProvider(
      { instrument: input.instrument, assetClass: "us_equity", side: input.action },
      signal,
    );
    const referencePrice = input.action === "buy" ? quote.askPrice : quote.bidPrice;
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
    const reconciliation = account.reconciliation;
    const decisionContext = await buildFinanceThesisDecisionContext({
      directory: params.directory,
      asOf: new Date(observedAtMs).toISOString(),
      instruments: [input.instrument],
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
    const failedReview = (
      failureCode: "reviewer_unavailable" | "output_invalid" | "runtime_timeout" | "process_error",
      attempted: boolean,
    ): FinanceTradeDecisionReviewResult => ({
      status: "failed" as const,
      attempted,
      provider: "unavailable",
      modelId: "unavailable",
      latencyMs: 0,
      providerCallObserved: false,
      adapterAttested: false,
      failureCode,
    });
    let rawReview: unknown;
    if (!params.tradeDecisionReviewer) {
      rawReview = failedReview("reviewer_unavailable", false);
    } else {
      try {
        rawReview = await withTimeout(
          params.tradeDecisionReviewer(
            reviewRequest,
            AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          ),
          35_000,
        );
      } catch (error) {
        rawReview = failedReview(
          error instanceof Error && error.message === "timeout"
            ? "runtime_timeout"
            : signal.aborted
              ? "runtime_timeout"
              : "process_error",
          true,
        );
      }
    }
    const reviewResult = isValidFinanceTradeDecisionReviewResult(rawReview, reviewRequest)
      ? rawReview
      : failedReview("output_invalid", true);
    const reviewedDecision =
      reviewResult.status === "completed" ? reviewResult.decisions?.[0] : undefined;
    tradeDecisionReview = FinanceIntradayDecisionReviewReceiptSchema.parse({
      request: reviewRequest,
      status: reviewResult.status,
      attempted: reviewResult.attempted,
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
    if (reviewResult.status !== "completed" || !reviewedDecision) {
      const outcome = await appendFinanceIntradayOutcome(params.directory, {
        signalId: input.signalId,
        status: "refused",
        reasons: ["intraday model review unavailable or invalid; refusing paper placement"],
        tradeDecisionReview,
      });
      return Object.freeze({
        status: "refused" as const,
        outcome: outcome.input,
        tradeDecisionReview,
      });
    }
    if (reviewedDecision.decision === "veto") {
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
    const result = await (params.runOrder ?? runFinanceAlpacaOrder)({
      credentialStateDirectory: params.directory,
      createSafetyContext: params.controller.createSafetyContext,
      conclusion: {
        conclusionId: input.signalId,
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
      reasons: [],
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
