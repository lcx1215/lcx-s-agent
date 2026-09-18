/**
 * Owner entry for the durable position ledger.
 *
 * `finance_live_execution_waterflow` ends at `execution_receipt`; nothing downstream of it
 * accumulated across runs, so the system could describe a trade but not hold a position.
 * This entry is the runnable surface for the ledger that closes that gap: it appends
 * execution receipts and price marks to an append-only SQLite ledger and re-derives
 * positions and PnL from what was stored.
 *
 * It is a ledger surface, not an execution surface. It never places an order, never reads a
 * credential, and never opens a network connection; receipts arrive from the execution owner
 * entry (`lcx-finance-live-execution.ts`) or from any adapter that emits the same schema.
 *
 * With `--initial-capital` it also derives the equity curve from the stored stream and runs
 * the existing metrics library over it. That wiring lives here, in the operator layer, on
 * purpose: the domain modules under `src/agents/` do not import the tool layer, so the script
 * is the correct side of that boundary. Two rules it follows:
 *
 *   - Period-free metrics (total return, max drawdown, drawdown duration, historical VaR) are
 *     reported whenever the curve exists, because they need no calendar assumption.
 *   - Annualised metrics (CAGR, Calmar, Sharpe, Sortino) are reported **only** when the caller
 *     declares `--periods-per-year`. The curve is sampled at mark instants, so the metrics
 *     library's defaults (252 for returns, 1 for levels) would silently treat one mark as one
 *     trading day or one year. A number nobody declared is worse than no number.
 *
 * The directory is resolved by the same `resolveFinancePositionLedgerLocation` the agent's read
 * tool uses, so the book this entry writes is the book the model reads. `--dir` still wins when
 * given; otherwise `LCX_FINANCE_STATE_DIR`, otherwise the workspace default. The payload always
 * reports which of the three it was, because reading or writing the wrong directory reports an
 * empty book rather than an error.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-position-ledger.ts --json [--dir PATH] \
 *     [--append-receipt FILE] [--mark SYM=PRICE@ISO]... [--as-of ISO] \
 *     [--initial-capital N] [--periods-per-year N]
 */

import fs from "node:fs/promises";
import {
  readFinanceEquityCurve,
  type FinanceEquityCurve,
} from "../../src/agents/finance-equity-curve.ts";
import type { FinanceExecutionReceipt } from "../../src/agents/finance-execution-adapter.ts";
import {
  advanceFinancePositionProjection,
  appendFinanceExecutionReceipt,
  appendFinancePositionMark,
  FINANCE_POSITION_LEDGER_PROJECTION,
  readFinancePositionLedger,
  readFinancePositionProjectionStatus,
  type FinancePositionMark,
} from "../../src/agents/finance-position-ledger.ts";
import { resolveFinancePositionLedgerLocation } from "../../src/agents/finance-state-dir.ts";
import {
  calculateCagr,
  calculateCalmarRatio,
  calculateDrawdownDuration,
  calculateHistoricalVar,
  calculateMaxDrawdown,
  calculateReturnsFromLevels,
  calculateSharpe,
  calculateSortino,
} from "../../src/agents/tools/quant-math-tool.ts";

export type Options = {
  /** Explicit ledger directory. When omitted, the shared resolver decides. */
  directory?: string;
  receiptPath?: string;
  marks: FinancePositionMark[];
  asOf?: string;
  initialCapital?: number;
  periodsPerYear?: number;
  /** Projection whose watermark is reported. Defaults to the ledger's own projection. */
  projection?: string;
  /** Projection whose watermark is advanced to the current head. Omit to leave it untouched. */
  advanceProjection?: string;
  json: boolean;
};

type AppendSummary = {
  recordKey: string;
  appended: boolean;
  sequence: number;
  ref: string;
};

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

function parsePositiveNumber(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive number, received: ${value ?? "(missing)"}`);
  }
  return parsed;
}

export function parseArgs(args: readonly string[]): Options {
  const options: Options = { marks: [], json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--dir") {
      options.directory = next?.trim() ?? "";
      index += 1;
    } else if (arg === "--append-receipt") {
      options.receiptPath = next ?? "";
      index += 1;
    } else if (arg === "--mark") {
      options.marks.push(parseMark(next));
      index += 1;
    } else if (arg === "--as-of") {
      options.asOf = next ?? "";
      index += 1;
    } else if (arg === "--initial-capital") {
      options.initialCapital = parsePositiveNumber("--initial-capital", next);
      index += 1;
    } else if (arg === "--periods-per-year") {
      options.periodsPerYear = parsePositiveNumber("--periods-per-year", next);
      index += 1;
    } else if (arg === "--projection") {
      options.projection = next ?? "";
      index += 1;
    } else if (arg === "--advance-projection") {
      options.advanceProjection = next ?? "";
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "Usage: node --import tsx scripts/operator/lcx-finance-position-ledger.ts [--json] " +
          "[--dir PATH] [--append-receipt FILE] [--mark SYM=PRICE@ISO] [--as-of ISO] " +
          "[--initial-capital N] [--periods-per-year N] " +
          "[--projection NAME] [--advance-projection NAME]",
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.periodsPerYear !== undefined && options.initialCapital === undefined) {
    throw new Error(
      "--periods-per-year needs --initial-capital: the period belongs to the equity curve, " +
        "and there is no curve without a starting capital",
    );
  }
  return options;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Accept either a bare receipt or a payload this repository already emits, so
 * `lcx-finance-live-execution.ts --json > run.json` can be replayed without hand-editing.
 * Picking the object is all this does; the persisted schema is the validator.
 */
async function readReceiptFile(file: string): Promise<FinanceExecutionReceipt> {
  const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
  const record = asRecord(parsed);
  if (record === undefined) {
    throw new Error(`${file} must contain a JSON object`);
  }
  const candidate =
    asRecord(asRecord(record.nodes)?.execution_receipt) ?? asRecord(record.receipt) ?? record;
  return candidate as unknown as FinanceExecutionReceipt;
}

/**
 * Run one metric, recording its refusal instead of propagating it. The metrics library throws
 * on a degenerate input (zero volatility, a flat curve, a non-positive level), and a thin
 * sample of marks makes that likely; the honest answer is "unavailable, and here is why".
 */
function attempt(
  label: string,
  fn: () => number,
  unavailable: Record<string, string>,
): number | null {
  try {
    return fn();
  } catch (error) {
    unavailable[label] = error instanceof Error ? error.message : String(error);
    return null;
  }
}

function attemptReturns(
  label: string,
  fn: () => number[],
  unavailable: Record<string, string>,
): number[] | null {
  try {
    return fn();
  } catch (error) {
    unavailable[label] = error instanceof Error ? error.message : String(error);
    return null;
  }
}

function buildMetricsSection(curve: FinanceEquityCurve, periodsPerYear: number | undefined) {
  const levels = [...curve.levels];
  const unavailable: Record<string, string> = {};
  const returns =
    levels.length < 2
      ? null
      : attemptReturns("returns", () => calculateReturnsFromLevels(levels).returns, unavailable);

  const periodFree = {
    // Period-free by construction: a ratio between two points on the same curve.
    totalReturn: curve.finalEquity === null ? null : curve.finalEquity / curve.initialCapital - 1,
    maxDrawdown:
      levels.length === 0
        ? null
        : attempt(
            "maxDrawdown",
            () => calculateMaxDrawdown(levels, "levels").maxDrawdown,
            unavailable,
          ),
    maxDrawdownDurationSamples:
      levels.length === 0
        ? null
        : attempt(
            "maxDrawdownDuration",
            () => calculateDrawdownDuration(levels, "levels").maxDuration,
            unavailable,
          ),
    // A per-sample quantile of the observed returns, so it needs no calendar either.
    historicalVar95:
      returns === null
        ? null
        : attempt(
            "historicalVar",
            () => calculateHistoricalVar({ series: returns }).valueAtRisk,
            unavailable,
          ),
  };

  const annualised =
    periodsPerYear === undefined || levels.length < 2
      ? null
      : {
          periodsPerYear,
          cagr: attempt(
            "cagr",
            () => calculateCagr(levels, "levels", periodsPerYear).cagr,
            unavailable,
          ),
          calmarRatio: attempt(
            "calmarRatio",
            () => calculateCalmarRatio(levels, "levels", periodsPerYear).calmarRatio,
            unavailable,
          ),
          sharpe:
            returns === null
              ? null
              : attempt(
                  "sharpe",
                  () => calculateSharpe({ series: returns, periodsPerYear }).sharpe,
                  unavailable,
                ),
          sortino:
            returns === null
              ? null
              : attempt(
                  "sortino",
                  () => calculateSortino({ series: returns, periodsPerYear }).sortino,
                  unavailable,
                ),
        };

  return {
    basis: "equity_levels_re_derived_from_the_stored_stream",
    observations: levels.length,
    ...periodFree,
    annualised,
    annualisedDeclared: periodsPerYear !== undefined,
    annualisedNote:
      periodsPerYear === undefined
        ? "no annualised metric is reported: the curve is sampled at mark instants rather than on a " +
          "calendar, so the period must be declared with --periods-per-year instead of assumed"
        : null,
    unavailable,
  };
}

export async function buildFinancePositionLedgerPayload(options: Options) {
  const location = resolveFinancePositionLedgerLocation({ directory: options.directory });
  const receipts: AppendSummary[] = [];
  const marks: AppendSummary[] = [];

  if (options.receiptPath !== undefined && options.receiptPath.length > 0) {
    const receipt = await readReceiptFile(options.receiptPath);
    const result = await appendFinanceExecutionReceipt(location.directory, receipt);
    receipts.push({
      recordKey: result.record.recordKey,
      appended: result.appended,
      sequence: result.record.sequence,
      ref: result.record.ref,
    });
  }
  for (const mark of options.marks) {
    const result = await appendFinancePositionMark(location.directory, mark);
    marks.push({
      recordKey: result.record.recordKey,
      appended: result.appended,
      sequence: result.record.sequence,
      ref: result.record.ref,
    });
  }

  // The watermark is advanced only when asked for. Advancing it on every run would make
  // "is this projection current?" unanswerable, which is the only question it exists to answer.
  const projectionName =
    options.projection?.trim() ||
    options.advanceProjection?.trim() ||
    FINANCE_POSITION_LEDGER_PROJECTION;
  const advanced =
    (options.advanceProjection?.trim().length ?? 0) === 0
      ? null
      : await advanceFinancePositionProjection(location.directory, { projection: projectionName });
  const projection = await readFinancePositionProjectionStatus(location.directory, projectionName);

  const read = await readFinancePositionLedger(
    location.directory,
    options.asOf === undefined || options.asOf.length === 0 ? {} : { asOf: options.asOf },
  );

  const curve =
    options.initialCapital === undefined
      ? null
      : await readFinanceEquityCurve(location.directory, {
          initialCapital: options.initialCapital,
        });

  const wrote =
    receipts.some((item) => item.appended) ||
    marks.some((item) => item.appended) ||
    advanced !== null;

  return {
    boundary: "local_position_ledger_only_no_venue_no_credentials",
    directory: location.directory,
    directorySource: location.source,
    /**
     * A write into the repository's own default location is the one case where this entry can
     * silently act on a book the operator did not name. The write still happens — the default is
     * this repository's convention and the agent's read tool resolves the same path — but it is
     * announced rather than assumed.
     */
    directorySourceNotice:
      wrote && location.source !== "explicit"
        ? `wrote to the ${location.source} location rather than one named with --dir; pass --dir or ` +
          "set LCX_FINANCE_STATE_DIR if this is not the book you meant"
        : null,
    database: location.database,
    appended: { receipts, marks },
    ledger: read.ledger,
    recordCount: read.recordCount,
    receiptRecordCount: read.receiptRecordCount,
    markRecordCount: read.markRecordCount,
    headRef: read.headRef,
    /**
     * How far `projection` has consumed the stream. `stale` means the stream holds records the
     * projection has not seen, and `recordsSince` is how many. Reported even on a read-only run:
     * without it a caller cannot tell a current projection from one that stopped days ago.
     */
    projection,
    projectionAdvanced: advanced !== null,
    equityCurve: curve,
    metrics: curve === null ? null : buildMetricsSection(curve, options.periodsPerYear),
    claims: {
      credentialsRead: false,
      networkTouched: false,
      venueOrderPlaced: false,
      placesOrders: false,
      databaseWritten: wrote,
    },
    liveTouched: false,
    liveTouchedReason: "this entry only reads and appends to a local SQLite ledger",
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = await buildFinancePositionLedgerPayload(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const positions = payload.ledger.positions;
  const lines = [
    `持仓账本：${payload.database}（位置来源：${payload.directorySource}）`,
    `记录：${payload.recordCount} 条（成交 ${payload.receiptRecordCount}，行情标记 ${payload.markRecordCount}）`,
    positions.length === 0
      ? "持仓：空"
      : `持仓：${positions
          .map((item) => `${item.instrument} ${item.quantity} @ 成本 ${item.averageCost}`)
          .join("；")}`,
    `已实现 PnL ${payload.ledger.realizedPnl}；未实现 PnL ${
      payload.ledger.unrealizedPnl === null
        ? "不可用（缺少带时间戳的 mark）"
        : payload.ledger.unrealizedPnl
    }`,
  ];
  if (payload.directorySourceNotice !== null) {
    lines.push(`注意：${payload.directorySourceNotice}`);
  }

  const curve = payload.equityCurve;
  if (curve !== null) {
    lines.push(
      `净值曲线：${curve.sampleCount} 个采样点，${curve.levels.length} 个有效点；` +
        `初始资金 ${curve.initialCapital}，期末净值 ${
          curve.finalEquity === null ? "不可用" : curve.finalEquity
        }`,
    );
    if (curve.undefinedEquityAt.length > 0) {
      lines.push(
        `  空洞：${curve.undefinedEquityAt.length} 个时点有持仓缺 mark，已从曲线中排除（不做插值）`,
      );
    }
    if (curve.receiptsAfterLastMark > 0) {
      lines.push(`  ${curve.receiptsAfterLastMark} 笔成交晚于最后一个 mark，未进入任何采样点`);
    }
    lines.push(
      `  采样间距：${
        curve.meanSampleSpacingSeconds === null ? "不可用" : `${curve.meanSampleSpacingSeconds} 秒`
      }`,
    );
  }

  const metrics = payload.metrics;
  if (metrics !== null) {
    const show = (value: number | null) =>
      value === null ? "不可用" : String(Number(value.toFixed(6)));
    lines.push(
      `指标（口径 ${metrics.basis}，${metrics.observations} 个观测）：` +
        `总收益 ${show(metrics.totalReturn)}；最大回撤 ${show(metrics.maxDrawdown)}；` +
        `回撤时长 ${show(metrics.maxDrawdownDurationSamples)} 个采样点；` +
        `历史 VaR(95%) ${show(metrics.historicalVar95)}`,
    );
    if (metrics.annualised === null) {
      lines.push(`  年化指标：未报告（${metrics.annualisedNote ?? "样本不足"}）`);
    } else {
      const a = metrics.annualised;
      lines.push(
        `  年化指标（每样本年数 = ${a.periodsPerYear}）：CAGR ${show(a.cagr)}；` +
          `Calmar ${show(a.calmarRatio)}；Sharpe ${show(a.sharpe)}；Sortino ${show(a.sortino)}`,
      );
    }
    for (const [label, reason] of Object.entries(metrics.unavailable)) {
      lines.push(`  指标 ${label} 不可用：${reason}`);
    }
  }

  lines.push("边界：只读写本地 SQLite 账本；不读凭据、不联网、不下单。");
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
