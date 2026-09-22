import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";

const INTRADAY_INTENT_PREFIX = "intent:intraday-";

/**
 * Keep the intraday overlay's inventory separate from core/daily positions that share the
 * same Alpaca paper account. An execution receipt is the ownership boundary: the strategy
 * may close only quantities opened by its own durable signal intents.
 */
export function receiptsForIntradayStrategy(
  receipts: readonly FinanceExecutionReceipt[],
  accountId?: string,
): readonly FinanceExecutionReceipt[] {
  return receipts.filter(
    (receipt) =>
      receipt.adapterKind === "venue" &&
      receipt.venue.startsWith("alpaca") &&
      receipt.intentId.startsWith(INTRADAY_INTENT_PREFIX) &&
      (accountId === undefined || receipt.accountId === accountId),
  );
}
