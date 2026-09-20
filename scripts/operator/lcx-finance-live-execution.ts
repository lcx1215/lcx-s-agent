/**
 * Owner entry for `finance_live_execution_waterflow`.
 *
 * This is the runnable surface for the declared chain
 * `execution_intent -> explicit_run_authorization -> declared_execution_adapter
 *  -> order_placement -> execution_receipt`, plus the position projection that accumulates
 * across runs.
 *
 * It deliberately exercises the paper adapter only. No credential is read, no network call
 * is made, and no venue is contacted, so this entry proves the *seam* and its refusals, not
 * a real order path. A venue adapter replaces `createPaperExecutionAdapter` at the same
 * call site without changing this file's structure.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-live-execution.ts --json \
 *     --instrument AAPL --quantity 10 --reference-price 231.4 \
 *     --as-of 2026-09-17T21:00:00Z --run-authorization run-2026-09-18-001 \
 *     --mark AAPL=233.1@2026-09-18T02:00:00Z
 *
 * `--allow-instrument` is optional and repeatable. With none given the run is open by
 * instrument; repeating it narrows the run to the named instruments.
 *
 * `--max-order-notional`, `--max-instrument-notional` and `--max-orders-per-run` are optional
 * too, and independent of each other. A cap that is not declared is not enforced — declaring it
 * is what creates the limit — while a declared cap is enforced exactly as before.
 *
 * The run is projected in memory by default and writes nothing. `--write-ledger` additionally
 * appends the receipt and marks to the durable book, which is what lets a position survive the
 * process that opened it. The ledger directory is resolved by the same
 * `resolveFinancePositionLedgerLocation` the agent's read tool uses (`--ledger-dir`, else
 * `LCX_FINANCE_STATE_DIR`, else the workspace default), and the payload always reports which.
 */

import { createAlpacaExecutionAdapter } from "../../src/agents/finance-alpaca-execution-adapter.js";
import {
  createPaperExecutionAdapter,
  DEFAULT_FINANCE_RISK_BUDGET,
  FINANCE_RISK_BUDGET_ANY_INSTRUMENT,
  type FinanceExecutionReceipt,
  type FinanceOrderSide,
  type FinanceOrderType,
  type FinanceRiskBudget,
  missingUnattendedCaps,
  placeFinanceOrder,
} from "../../src/agents/finance-execution-adapter.ts";
import { evaluateFinanceMandate } from "../../src/agents/finance-mandate.js";
import {
  appendFinanceExecutionReceipt,
  appendFinancePositionMark,
  projectFinancePositions,
  readFinancePositionLedger,
  type FinancePositionMark,
} from "../../src/agents/finance-position-ledger.ts";
import { resolveFinancePositionLedgerLocation } from "../../src/agents/finance-state-dir.ts";
import { createFinanceWriteTransport } from "../../src/agents/finance-write-transport.js";

export type Options = {
  instrument: string;
  side: FinanceOrderSide;
  orderType: FinanceOrderType;
  quantity: number;
  limitPrice?: number;
  referencePrice?: number;
  asOf: string;
  runAuthorization: string;
  rationale: string;
  allowInstruments: string[];
  marks: FinancePositionMark[];
  budget: FinanceRiskBudget;
  /** Append this run's receipt and marks to the durable book instead of only projecting in memory. */
  writeLedger: boolean;
  /** Which declared execution adapter to place through. `paper` stays the default. */
  adapter?: "paper" | "alpaca";
  /** Alpaca only: `paper` (default) or `live`. Live needs a funded AK-prefixed key. */
  alpacaMode?: "paper" | "live";
  /**
   * Asset class for the trading mandate gate. The gate only runs when this is
   * declared: without it the strategy class cannot be determined, and guessing a
   * class would launder a guess into an enforced decision.
   */
  assetClass?: string;
  /** Risk at stake on this order, as a percentage of equity. Required by the gate. */
  riskPct?: number;
  /** Current peak-to-trough drawdown as a positive percentage. */
  drawdownPct?: number;
  /** Declared stop. Classes that require a stop refuse without one. */
  stopPrice?: number;
  /** Declares that significant ACF/PACF structure was found. Absent = refuse. */
  hasStructure?: boolean;
  /** Set when this order adds to an existing losing position. */
  averagingDown?: boolean;
  /** Set when size was raised to win back a loss. */
  revengeSizing?: boolean;
  /** Explicit ledger directory. When omitted, the shared resolver decides. */
  ledgerDirectory?: string;
  json: boolean;
};

type AppendSummary = {
  recordKey: string;
  appended: boolean;
  sequence: number;
  ref: string;
};

function parsePositiveNumber(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive number`);
  }
  return parsed;
}

function parseMark(value: string | undefined): FinancePositionMark {
  if (value === undefined) {
    throw new Error("--mark requires SYMBOL=PRICE@ISO_TIMESTAMP");
  }
  const [instrument, rest] = value.split("=");
  const [priceText, at] = (rest ?? "").split("@");
  const price = Number(priceText);
  if (!instrument?.trim() || !Number.isFinite(price) || price <= 0 || !at?.trim()) {
    throw new Error(`--mark must be SYMBOL=PRICE@ISO_TIMESTAMP, received: ${value}`);
  }
  return { instrument: instrument.trim(), price, at: at.trim() };
}

export function parseArgs(args: readonly string[]): Options {
  const options: Options = {
    instrument: "",
    side: "buy",
    orderType: "market",
    quantity: 1,
    asOf: "",
    runAuthorization: "",
    rationale: "owner entry smoke: paper execution seam",
    allowInstruments: [],
    marks: [],
    budget: DEFAULT_FINANCE_RISK_BUDGET,
    writeLedger: false,
    adapter: "paper",
    alpacaMode: "paper",
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--instrument") {
      options.instrument = next ?? "";
      index += 1;
    } else if (arg === "--side") {
      if (next !== "buy" && next !== "sell") {
        throw new Error("--side must be buy or sell");
      }
      options.side = next;
      index += 1;
    } else if (arg === "--order-type") {
      if (next !== "market" && next !== "limit") {
        throw new Error("--order-type must be market or limit");
      }
      options.orderType = next;
      index += 1;
    } else if (arg === "--quantity") {
      options.quantity = parsePositiveNumber("--quantity", next);
      index += 1;
    } else if (arg === "--limit-price") {
      options.limitPrice = parsePositiveNumber("--limit-price", next);
      index += 1;
    } else if (arg === "--reference-price") {
      options.referencePrice = parsePositiveNumber("--reference-price", next);
      index += 1;
    } else if (arg === "--as-of") {
      options.asOf = next ?? "";
      index += 1;
    } else if (arg === "--run-authorization") {
      options.runAuthorization = next ?? "";
      index += 1;
    } else if (arg === "--rationale") {
      options.rationale = next ?? "";
      index += 1;
    } else if (arg === "--allow-instrument") {
      if (!next?.trim()) {
        throw new Error("--allow-instrument requires a non-empty symbol");
      }
      options.allowInstruments.push(next.trim());
      index += 1;
    } else if (arg === "--mark") {
      options.marks.push(parseMark(next));
      index += 1;
    } else if (arg === "--write-ledger") {
      options.writeLedger = true;
    } else if (arg === "--adapter") {
      if (next !== "paper" && next !== "alpaca") {
        throw new Error("--adapter expects paper or alpaca");
      }
      options.adapter = next;
      index += 1;
    } else if (arg === "--alpaca-mode") {
      if (next !== "paper" && next !== "live") {
        throw new Error("--alpaca-mode expects paper or live");
      }
      options.alpacaMode = next;
      index += 1;
    } else if (arg === "--asset-class") {
      options.assetClass = next;
      index += 1;
    } else if (arg === "--risk-pct") {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("--risk-pct expects a non-negative number");
      }
      options.riskPct = parsed;
      index += 1;
    } else if (arg === "--drawdown-pct") {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("--drawdown-pct expects a non-negative number");
      }
      options.drawdownPct = parsed;
      index += 1;
    } else if (arg === "--stop-price") {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--stop-price expects a positive number");
      }
      options.stopPrice = parsed;
      index += 1;
    } else if (arg === "--has-structure") {
      options.hasStructure = true;
    } else if (arg === "--averaging-down") {
      options.averagingDown = true;
    } else if (arg === "--revenge-sizing") {
      options.revengeSizing = true;
    } else if (arg === "--ledger-dir") {
      options.ledgerDirectory = next?.trim() ?? "";
      index += 1;
    } else if (arg === "--max-order-notional") {
      options.budget = { ...options.budget, maxOrderNotional: parsePositiveNumber(arg, next) };
      index += 1;
    } else if (arg === "--max-instrument-notional") {
      options.budget = { ...options.budget, maxInstrumentNotional: parsePositiveNumber(arg, next) };
      index += 1;
    } else if (arg === "--max-orders-per-run") {
      options.budget = { ...options.budget, maxOrdersPerRun: parsePositiveNumber(arg, next) };
      index += 1;
    } else if (arg === "--automation") {
      if (next !== "attended" && next !== "unattended") {
        throw new Error("--automation must be attended or unattended");
      }
      options.budget = { ...options.budget, automation: next };
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "Usage: node --import tsx scripts/operator/lcx-finance-live-execution.ts [--json] " +
          "--instrument SYM --reference-price N --as-of ISO --run-authorization ID " +
          "[--allow-instrument SYM] [--side buy|sell] [--quantity N] [--order-type market|limit] " +
          "[--limit-price N] [--mark SYM=PRICE@ISO] [--max-order-notional N] " +
          "[--max-instrument-notional N] [--max-orders-per-run N] " +
          "[--automation attended|unattended] " +
          "[--write-ledger] [--ledger-dir PATH]\n" +
          "Omitting --allow-instrument leaves the run open by instrument; repeating it narrows " +
          "the run to the named instruments. Each --max-* cap is optional and enforced only when " +
          "declared, EXCEPT under --automation unattended, where all three are required: a run " +
          "with nobody watching that declines to name a ceiling has none. Without --write-ledger " +
          "nothing is persisted.",
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export async function buildFinanceLiveExecutionPayload(options: Options) {
  // The allowlist narrows only when the caller names instruments. With none named the run is
  // open by instrument, and both checks in the adapter seam stay in force — so an explicit
  // empty list, or a list naming other instruments, still refuses.
  const allowedInstruments: readonly string[] = Object.freeze(
    options.allowInstruments.length > 0
      ? [...options.allowInstruments]
      : [FINANCE_RISK_BUDGET_ANY_INSTRUMENT],
  );
  const budget: FinanceRiskBudget = Object.freeze({
    ...options.budget,
    allowedInstruments,
  });
  const adapters = Object.freeze([
    options.adapter === "alpaca"
      ? createAlpacaExecutionAdapter({
          instruments: allowedInstruments,
          mode: options.alpacaMode,
          postJson: async (url, init) => {
            const transport = createFinanceWriteTransport();
            const response = await transport({
              url,
              headers: init.headers,
              body: init.body,
              signal: init.signal,
            });
            return { status: response.status, body: response.body };
          },
          fillPoll: { timeoutMs: 15_000, intervalMs: 500 },
        })
      : createPaperExecutionAdapter({ instruments: allowedInstruments }),
  ]);

  // Which ceilings an unattended run still owes, spelled out as cap names rather than refusal
  // codes. The adapter refuses either way; this is so the operator reads "you owe
  // maxOrdersPerRun" instead of reverse-engineering it from a snake_case code.
  const unattendedMissingCaps = missingUnattendedCaps(budget);

  // The mandate runs before the order exists: a rule that only reports
  // afterwards cannot prevent anything. It is skipped unless an asset class is
  // declared, because a guess at the class would launder a guess into an
  // enforced decision. Everything the mandate needs is passed explicitly -
  // nothing is defaulted to "good enough" so the order can proceed.
  if (options.assetClass !== undefined) {
    if (options.riskPct === undefined) {
      throw new Error("--asset-class requires --risk-pct so the mandate can judge the risk");
    }
    const mandate = evaluateFinanceMandate({
      strategy: { assetClass: options.assetClass },
      riskFractionOfEquity: options.riskPct / 100,
      drawdownFraction: (options.drawdownPct ?? 0) / 100,
      ...(options.stopPrice !== undefined ? { stopLossDefined: true } : {}),
      ...(options.hasStructure !== undefined
        ? { hasSignificantAutocorrelation: options.hasStructure }
        : {}),
      ...(options.averagingDown !== undefined ? { averagingDown: options.averagingDown } : {}),
      ...(options.revengeSizing !== undefined ? { revengeSizing: options.revengeSizing } : {}),
    });
    if (mandate.verdict !== "pass") {
      throw new Error(
        `trading mandate ${mandate.verdict} for class ${String(mandate.strategyClass)}: ${mandate.reasons.join("; ")}`,
      );
    }
  }

  const placement = await placeFinanceOrder({
    mode: "live_execution",
    adapters,
    executionAdapterId: "paper",
    budget,
    committedInstrumentNotional: 0,
    ordersPlacedThisRun: 0,
    intent: {
      intentId: "owner-entry-intent-1",
      instrument: options.instrument,
      side: options.side,
      orderType: options.orderType,
      quantity: options.quantity,
      ...(options.limitPrice === undefined ? {} : { limitPrice: options.limitPrice }),
      referencePrice: options.referencePrice ?? Number.NaN,
      referencePriceAt: options.asOf,
      runAuthorizationId: options.runAuthorization,
      rationale: options.rationale,
    },
  });

  const receipts: readonly FinanceExecutionReceipt[] =
    placement.receipt === undefined ? [] : [placement.receipt];
  const ledger = projectFinancePositions({ receipts, marks: options.marks });

  // The durable book is resolved and read even when this run does not write, so the payload can
  // say where a write would land and what is already there. An operator comparing this entry
  // against the agent's read tool needs both halves, not only the one this run chose.
  const location = resolveFinancePositionLedgerLocation({ directory: options.ledgerDirectory });
  const before = await readFinancePositionLedger(location.directory);

  let appendedReceipt: AppendSummary | null = null;
  const appendedMarks: AppendSummary[] = [];
  let wrote = false;
  let durableReason: string | null = null;

  if (!options.writeLedger) {
    durableReason = "pass --write-ledger to append this run to the durable book";
  } else if (placement.receipt === undefined) {
    // A refused order produced nothing to record. The marks are not written either: this run left
    // no trace in the book, and a mark can always be appended on its own by the ledger entry.
    durableReason = "order_refused_so_nothing_was_recorded";
  } else {
    const receiptAppend = await appendFinanceExecutionReceipt(
      location.directory,
      placement.receipt,
    );
    appendedReceipt = {
      recordKey: receiptAppend.record.recordKey,
      appended: receiptAppend.appended,
      sequence: receiptAppend.record.sequence,
      ref: receiptAppend.record.ref,
    };
    for (const mark of options.marks) {
      const markAppend = await appendFinancePositionMark(location.directory, mark);
      appendedMarks.push({
        recordKey: markAppend.record.recordKey,
        appended: markAppend.appended,
        sequence: markAppend.record.sequence,
        ref: markAppend.record.ref,
      });
    }
    wrote = true;
  }

  const after = wrote ? await readFinancePositionLedger(location.directory) : null;
  const recordCount = after?.recordCount ?? before.recordCount;

  return {
    boundary: "paper_execution_adapter_only_no_credentials_no_venue",
    waterflow: "finance_live_execution_waterflow",
    nodes: {
      execution_intent: {
        instrument: options.instrument,
        side: options.side,
        orderType: options.orderType,
        quantity: options.quantity,
      },
      explicit_run_authorization: {
        runAuthorizationId: options.runAuthorization,
        present: options.runAuthorization.trim().length > 0,
      },
      declared_execution_adapter: {
        adapterId: "paper",
        // What the adapter actually declares, not the raw flag: with no --allow-instrument the
        // adapter declares the any-instrument token, and reporting the empty flag list here
        // would contradict the placement that just succeeded.
        declaredInstruments: allowedInstruments,
      },
      order_placement: { status: placement.status, refusalReasons: placement.refusalReasons },
      ...(unattendedMissingCaps.length === 0
        ? {}
        : { unattended_requires_caps: unattendedMissingCaps }),
      execution_receipt: placement.receipt ?? null,
      // Present only when this run actually persisted something. A run that did not write must
      // not claim a ledger node, or the waterflow would look complete on a run that left no trace.
      position_ledger: wrote
        ? {
            directory: location.directory,
            directorySource: location.source,
            database: location.database,
            recordCount,
            headRef: after?.headRef ?? null,
          }
        : null,
    },
    riskBudget: budget,
    positionLedger: ledger,
    durableLedger: {
      written: wrote,
      reason: durableReason,
      directory: location.directory,
      directorySource: location.source,
      database: location.database,
      // Writing into a location the operator did not name is allowed — the default is this
      // repository's convention and the agent's read tool resolves the same path — but it is
      // announced rather than assumed.
      directorySourceNotice:
        wrote && location.source !== "explicit"
          ? `wrote to the ${location.source} location rather than one named with --ledger-dir; pass ` +
            "--ledger-dir or set LCX_FINANCE_STATE_DIR if this is not the book you meant"
          : null,
      appended: { receipt: appendedReceipt, marks: appendedMarks },
      // Each run is a new placement, so the adapter mints a fresh receipt id and the fill is
      // recorded as new. Replaying *one* receipt idempotently is the ledger entry's job
      // (`--append-receipt`), which is keyed on `receiptId`. Saying so here keeps an operator from
      // reading a second run's second fill as a duplicate.
      replayNote: wrote
        ? "each run places a new order and records a new fill; to replay one receipt idempotently " +
          "use lcx-finance-position-ledger.ts --append-receipt"
        : null,
      beforeRecordCount: before.recordCount,
      recordCount,
      recordCountDelta: recordCount - before.recordCount,
      receiptRecordCount: after?.receiptRecordCount ?? before.receiptRecordCount,
      markRecordCount: after?.markRecordCount ?? before.markRecordCount,
      headRef: after?.headRef ?? before.headRef,
      // Re-derived from what was stored rather than from this run's in-memory projection, so the
      // two can be compared: if they ever disagree, the book and the run have diverged.
      ledger: after?.ledger ?? null,
    },
    claims: {
      paperAdapterOnly: true,
      credentialsRead: false,
      networkTouched: false,
      venueOrderPlaced: false,
      realOrderPathImplemented: false,
      unrealizedPnlAvailable: ledger.unrealizedPnl !== null,
      databaseWritten: wrote,
    },
    liveTouched: false,
    liveTouchedReason:
      "only the paper adapter ran; no venue, credential, account or network path is used",
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = await buildFinanceLiveExecutionPayload(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `场景：finance_live_execution_waterflow（owner 入口，仅 paper 适配器）`,
      `order_placement：${payload.nodes.order_placement.status}${
        payload.nodes.order_placement.refusalReasons.length > 0
          ? `（${payload.nodes.order_placement.refusalReasons.join(", ")}）`
          : ""
      }`,
      `持仓：${payload.positionLedger.positions.length} 个标的，已实现 PnL ${payload.positionLedger.realizedPnl}；未实现 PnL ${
        payload.positionLedger.unrealizedPnl === null
          ? "不可用（缺少带时间戳的 mark）"
          : payload.positionLedger.unrealizedPnl
      }`,
      payload.durableLedger.written
        ? `持久账本：已写入 ${payload.durableLedger.database}` +
          `（位置来源：${payload.durableLedger.directorySource}，` +
          `记录 ${payload.durableLedger.beforeRecordCount} → ${payload.durableLedger.recordCount}）`
        : `持久账本：未写入（${payload.durableLedger.reason}）；解析位置 ${payload.durableLedger.database}` +
          `（来源：${payload.durableLedger.directorySource}）`,
      ...(payload.durableLedger.directorySourceNotice === null
        ? []
        : [`注意：${payload.durableLedger.directorySourceNotice}`]),
      `边界：未读凭据、未联网、未触达任何交易场所；真实下单路径仍未实现。`,
    ].join("\n") + "\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
