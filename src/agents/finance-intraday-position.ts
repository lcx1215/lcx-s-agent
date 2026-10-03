import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
import { readFinanceIntradayDecisions } from "./finance-intraday-control-ledger.js";
import {
  FINANCE_INTRADAY_OPENING_RANGE_FORM,
  resolveFinanceIntradayActiveRuleContract,
} from "./finance-intraday-paper.js";
import {
  readFinanceOwnedProtectionExitFacts,
  type FinanceOwnedProtectionExitFact,
} from "./finance-owned-protection-exits.js";
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

type OpenIntradayLot = {
  entryReceiptId: string;
  intentId: string;
  instrument: string;
  quantity: number;
  fillPrice: number;
};

/** Native exits are broker facts tied to an owned entry, never manufactured execution receipts. */
export function projectFinanceIntradayOwnedPositions(
  receipts: readonly FinanceExecutionReceipt[],
  protectionExits: readonly FinanceOwnedProtectionExitFact[],
) {
  const receiptIds = new Set(receipts.map((receipt) => receipt.receiptId));
  protectionExits = protectionExits.filter((exit) => receiptIds.has(exit.entryReceiptId));
  const lots: OpenIntradayLot[] = [];
  const events = [
    ...receipts.map((receipt) => ({
      kind: "receipt" as const,
      at: receipt.fill.filledAt,
      key: receipt.receiptId,
      receipt,
    })),
    ...protectionExits.flatMap((exit) =>
      exit.fills.map((fill) => ({
        kind: "protection" as const,
        at: fill.occurredAt,
        key: fill.activityId,
        exit,
        fill,
      })),
    ),
  ].toSorted(
    (left, right) =>
      Date.parse(left.at) - Date.parse(right.at) || left.key.localeCompare(right.key),
  );
  for (const event of events) {
    if (event.kind === "protection") {
      const lot = lots.find((item) => item.entryReceiptId === event.exit.entryReceiptId);
      if (!lot || event.fill.quantity > lot.quantity + 1e-6) {
        throw new Error("owned protection fill exceeds its remaining entry lot");
      }
      lot.quantity = Math.max(0, lot.quantity - event.fill.quantity);
      continue;
    }
    const { receipt } = event;
    if (receipt.side === "buy") {
      lots.push({
        entryReceiptId: receipt.receiptId,
        intentId: receipt.intentId,
        instrument: receipt.instrument,
        quantity: receipt.fill.filledQuantity,
        fillPrice: receipt.fill.fillPrice,
      });
      continue;
    }
    let toClose = receipt.fill.filledQuantity;
    for (const lot of lots) {
      if (lot.instrument !== receipt.instrument || toClose <= 1e-6) {
        continue;
      }
      const closed = Math.min(lot.quantity, toClose);
      lot.quantity -= closed;
      toClose -= closed;
    }
    if (toClose > 1e-6) {
      throw new Error("intraday sell fill exceeds its existing owned lots");
    }
  }
  const openLots = lots.filter((lot) => lot.quantity > 1e-6);
  const positions = projectFinancePositions({ receipts }).positions.map((position) => {
    const exits = protectionExits.filter((exit) => exit.instrument === position.instrument);
    const quantity = Number(
      (position.quantity - exits.reduce((sum, exit) => sum + exit.filledQuantity, 0)).toFixed(6),
    );
    const remaining = openLots.filter((lot) => lot.instrument === position.instrument);
    const cost = remaining.reduce((sum, lot) => sum + lot.quantity * lot.fillPrice, 0);
    return Object.freeze({
      instrument: position.instrument,
      quantity,
      averageCost: exits.length > 0 ? (quantity > 0 ? cost / quantity : 0) : position.averageCost,
    });
  });
  return Object.freeze({ positions, openLots, protectionExits });
}

export async function readFinanceIntradayOwnedPositions(params: {
  directory: string;
  accountId?: string;
  receipts: readonly FinanceExecutionReceipt[];
}) {
  const receipts = receiptsForIntradayStrategy(params.receipts, params.accountId);
  const protectionExits = params.accountId
    ? await readFinanceOwnedProtectionExitFacts({
        directory: params.directory,
        accountId: params.accountId,
        venue: "alpaca:paper",
        receipts,
      })
    : [];
  return projectFinanceIntradayOwnedPositions(receipts, protectionExits);
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
  const book = await readFinanceIntradayOwnedPositions({ directory, accountId, receipts });
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
    const boundBook = projectFinanceIntradayOwnedPositions(bound, book.protectionExits);
    for (const position of boundBook.positions) {
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
  const allBook = await readFinanceIntradayOwnedPositions({
    directory,
    accountId,
    receipts: allIntraday,
  });
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
    const boundBook = projectFinanceIntradayOwnedPositions(bound, allBook.protectionExits);
    for (const position of boundBook.positions) {
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
