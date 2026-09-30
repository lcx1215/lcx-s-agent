import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
import { readFinanceIntradayDecisions } from "./finance-intraday-control-ledger.js";
import {
  FINANCE_INTRADAY_OPENING_RANGE_FORM,
  resolveFinanceIntradayActiveRuleContract,
} from "./finance-intraday-paper.js";
import { projectFinancePositions, readFinancePositionRecords } from "./finance-position-ledger.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";

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
      receipt.venue === "alpaca:paper" &&
      receipt.intentId.startsWith(INTRADAY_INTENT_PREFIX) &&
      (accountId === undefined || receipt.accountId === accountId),
  );
}

/** Discover only proven retired inventory; never borrow current strategy scope or core holdings. */
export async function readFinanceRetiredIntradayExitTargets(directory: string, accountId: string) {
  if (!accountId.trim()) {
    throw new Error("retired exits require an account");
  }
  const { ledger } = await readFinanceStrategyRuleLedger(directory);
  const records = await readFinancePositionRecords(directory);
  const receipts = receiptsForIntradayStrategy(records.receipts, accountId);
  const decisions = await readFinanceIntradayDecisions(directory);
  const book = projectFinancePositions({ receipts });
  const targets = [];
  for (const rule of ledger.rules) {
    if (rule.state !== "retired" || rule.form !== FINANCE_INTRADAY_OPENING_RANGE_FORM) {
      continue;
    }
    const contract = resolveFinanceIntradayActiveRuleContract(rule, { allowRetiredExit: true });
    if (!contract.eligibility.automatedPaperPlacementAllowed) {
      continue;
    }
    const bound = receipts.filter((receipt) =>
      decisions.some(
        (record) =>
          receipt.intentId === `intent:${record.input.signalId}` &&
          receipt.side === record.input.action &&
          receipt.instrument === record.input.instrument &&
          record.input.strategyRule === rule.ruleId &&
          record.input.strategyBinding?.declarationRef === contract.declarationRef &&
          record.input.strategyBinding?.activationRef === contract.activationRef &&
          record.input.strategyBinding?.scope !== "explicit_diagnostic",
      ),
    );
    for (const position of projectFinancePositions({ receipts: bound }).positions) {
      if (
        position.quantity > 0 &&
        (contract.paperUniverseScope === "fresh_us_equity_selection_v1" ||
          contract.instruments.includes(position.instrument)) &&
        position.quantity ===
          book.positions.find((p) => p.instrument === position.instrument)?.quantity
      ) {
        targets.push({ instrument: position.instrument, quantity: position.quantity, contract });
      }
    }
  }
  return targets;
}

/** Open lots from an opted-in dynamic Paper rule remain managed after leaving the entry universe. */
export async function readFinanceDynamicIntradayExitTargets(
  directory: string,
  accountId: string,
  selectedInstruments: readonly string[],
) {
  if (!accountId.trim()) {
    throw new Error("dynamic exits require an account");
  }
  const { ledger } = await readFinanceStrategyRuleLedger(directory);
  const records = await readFinancePositionRecords(directory);
  const allIntraday = records.receipts.filter(
    (receipt) =>
      receipt.adapterKind === "venue" &&
      receipt.venue === "alpaca:paper" &&
      receipt.accountId === accountId &&
      receipt.fill.filledQuantity > 0 &&
      receipt.fill.terminalOrderIdentity?.terminal === true &&
      receipt.intentId.startsWith(INTRADAY_INTENT_PREFIX),
  );
  const decisions = await readFinanceIntradayDecisions(directory);
  const allBook = projectFinancePositions({ receipts: allIntraday });
  const selected = new Set(selectedInstruments.map((instrument) => instrument.toUpperCase()));
  const targets = [];
  for (const rule of ledger.rules) {
    if (rule.state !== "active" || rule.form !== FINANCE_INTRADAY_OPENING_RANGE_FORM) {
      continue;
    }
    const contract = resolveFinanceIntradayActiveRuleContract(rule);
    if (contract.paperUniverseScope !== "fresh_us_equity_selection_v1") {
      continue;
    }
    const bound = allIntraday.filter((receipt) =>
      decisions.some(
        (record) =>
          receipt.intentId === `intent:${record.input.signalId}` &&
          receipt.side === record.input.action &&
          receipt.instrument === record.input.instrument &&
          record.input.strategyRule === rule.ruleId &&
          record.input.strategyBinding?.declarationRef === contract.declarationRef &&
          record.input.strategyBinding?.activationRef === contract.activationRef &&
          record.input.strategyBinding?.scope === "system_universe",
      ),
    );
    for (const position of projectFinancePositions({ receipts: bound }).positions) {
      if (
        position.quantity > 0 &&
        !selected.has(position.instrument) &&
        position.quantity ===
          allBook.positions.find((item) => item.instrument === position.instrument)?.quantity
      ) {
        targets.push({ instrument: position.instrument, quantity: position.quantity, contract });
      }
    }
  }
  return targets;
}
