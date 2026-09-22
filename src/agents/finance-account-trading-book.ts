import {
  reconcileFinanceBrokerHistory,
  type FinanceBrokerHistoryReconciliation,
} from "./finance-alpaca-history-reconciliation.js";
import {
  readFinanceAccountPositionLedger,
  type FinancePositionLedger,
} from "./finance-position-ledger.js";

export const FINANCE_ACCOUNT_TRADING_BOOK_SCHEMA = "lcx_finance_account_trading_book_v1" as const;

export type FinanceAccountTradingBook = Readonly<{
  schemaVersion: typeof FINANCE_ACCOUNT_TRADING_BOOK_SCHEMA;
  accountId: string;
  venue: string;
  /** The source allowed to describe the current account book. */
  baselineSource: "broker_history" | "execution_receipts" | "unavailable";
  /** A position projection is never an execution receipt. */
  positions: FinancePositionLedger["positions"] | FinanceBrokerHistoryReconciliation["positions"];
  executionReceiptCount: number;
  brokerFillCount: number;
  matchedReceiptCount: number;
  unmatchedFillCount: number;
  /** Instruments whose broker fills have no matching LCX venue receipt. */
  historicalOnlyInstruments: readonly string[];
  /** True only when the broker history is complete and its order/fill coverage is sound. */
  brokerBaselineUsable: boolean;
  warnings: readonly string[];
  execution: Awaited<ReturnType<typeof readFinanceAccountPositionLedger>>;
  brokerHistory: FinanceBrokerHistoryReconciliation;
}>;

function receiptOrderIds(
  receipts: Awaited<ReturnType<typeof readFinanceAccountPositionLedger>>["receipts"],
): Set<string> {
  return new Set(
    receipts.flatMap((receipt) => {
      const orderId = receipt.fill.terminalOrderIdentity?.orderId;
      return receipt.adapterKind === "venue" && orderId ? [orderId] : [];
    }),
  );
}

/**
 * Read the account book without merging raw broker history into LCX execution receipts.
 *
 * A reconciled broker projection can be the position baseline for risk context, while the
 * execution receipt stream remains the authority for LCX-created orders. Historical fills without
 * a receipt are surfaced as coverage gaps and are never converted into a new receipt.
 */
export async function readFinanceAccountTradingBook(params: {
  directory: string;
  accountId: string;
  venue: string;
}): Promise<FinanceAccountTradingBook> {
  const execution = await readFinanceAccountPositionLedger(params.directory, {
    accountId: params.accountId,
    venue: params.venue,
  });
  const brokerHistory = await reconcileFinanceBrokerHistory(params.directory, params.accountId);
  const orderIds = receiptOrderIds(execution.receipts);
  const historicalOnlyInstruments = [
    ...new Set(
      brokerHistory.fills
        .filter((fill) => !orderIds.has(fill.orderId))
        .map((fill) => fill.instrument),
    ),
  ].toSorted();
  const brokerBaselineUsable = brokerHistory.positionBaselineUsable;
  const baselineSource = brokerBaselineUsable
    ? ("broker_history" as const)
    : execution.receipts.length > 0
      ? ("execution_receipts" as const)
      : ("unavailable" as const);
  const warnings = [
    ...brokerHistory.warnings,
    ...(historicalOnlyInstruments.length > 0
      ? [
          `historical-only broker fills remain outside the LCX receipt chain for ${historicalOnlyInstruments.join(", ")}`,
        ]
      : []),
  ];
  return Object.freeze({
    schemaVersion: FINANCE_ACCOUNT_TRADING_BOOK_SCHEMA,
    accountId: params.accountId,
    venue: params.venue,
    baselineSource,
    positions: brokerBaselineUsable ? brokerHistory.positions : execution.ledger.positions,
    executionReceiptCount: execution.receipts.length,
    brokerFillCount: brokerHistory.brokerFillCount,
    matchedReceiptCount: brokerHistory.matchedReceiptCount,
    unmatchedFillCount: brokerHistory.unmatchedFillCount,
    historicalOnlyInstruments: Object.freeze(historicalOnlyInstruments),
    brokerBaselineUsable,
    warnings: Object.freeze(warnings),
    execution,
    brokerHistory,
  });
}
