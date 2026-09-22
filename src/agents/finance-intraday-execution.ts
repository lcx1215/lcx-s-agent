import { runFinanceAlpacaOrder } from "./finance-alpaca-run.js";
import { recordCycleFill, type FinanceDailyCycleParams } from "./finance-daily-cycle.js";
import {
  appendFinanceIntradayOutcome,
  readFinanceIntradayOutcome,
  type FinanceIntradayDecisionRecord,
} from "./finance-intraday-control-ledger.js";
import { receiptsForIntradayStrategy } from "./finance-intraday-position.js";
import { projectFinancePositions, readFinancePositionRecords } from "./finance-position-ledger.js";

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
  signal?: AbortSignal;
  runOrder?: typeof runFinanceAlpacaOrder;
  recordFill?: typeof recordCycleFill;
}) {
  const prior = await readFinanceIntradayOutcome(params.directory, params.decision.input.signalId);
  if (prior) {
    return Object.freeze({ status: "already_terminal" as const, outcome: prior });
  }
  const input = params.decision.input;
  const signal = params.signal ?? AbortSignal.timeout(120_000);
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
      });
      return Object.freeze({ status: "refused" as const, outcome: outcome.input });
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
      });
      return Object.freeze({ status: "uncertain" as const, outcome: outcome.input });
    }
    const outcome = await appendFinanceIntradayOutcome(params.directory, {
      signalId: input.signalId,
      status: "placed",
      receiptId: result.receipt.receiptId,
      reasons: [],
    });
    return Object.freeze({
      status: "placed" as const,
      outcome: outcome.input,
      receipt: result.receipt,
      ledger: recorded,
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
    });
    return Object.freeze({
      status: uncertain ? ("uncertain" as const) : ("refused" as const),
      outcome: outcome.input,
    });
  }
}
