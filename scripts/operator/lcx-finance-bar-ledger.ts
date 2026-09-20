/**
 * Operator entry for the bar book.
 *
 * The bar book is the only durable home for OHLCV-shaped observations. Everything else in the
 * finance surface either recomputes from a stream (behaviour profile, readiness, equity curve) or
 * expects the caller to hand it data in the moment (chart analysis). Because the chart module has
 * no local supply, range-based measures — true drawdown, ATR, support/resistance — have had
 * nothing to read. This book is that supply.
 *
 * Two write paths, and the difference between them is the whole point of the book:
 *
 *   --append FILE    exchange-aggregated OHLCV (`derivation: "ohlcv"`). The caller states four
 *                    prices that were actually observed.
 *   --from-marks     derived from point observations already in the position ledger
 *                    (`derivation: "point_derived"`). The caller states *points*; this module
 *                    computes the range and records `sampleCount`.
 *
 * The second path exists because a point observation has no intraday range. Asking a caller for
 * `high`/`low` it could not have seen would produce bars that look like OHLCV and would then be
 * fed to range measure that return confident numbers derived from numbers nobody observed. So the
 * input shape refuses to express a range; the module derives what it can and marks every bar with
 * how many observations produced it. `sampleCount: 1` means `high === low` — the range is
 * *unknown*, not zero.
 *
 * Nothing here places an order, reads a credential, or touches the network.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-bar-ledger.ts [--json] \
 *     [--dir PATH] [--append FILE] [--from-marks] [--instrument SYM] [--as-of ISO]
 */

import fs from "node:fs/promises";
import {
  appendFinanceBars,
  financeBarLedgerExists,
  readFinanceBarLedger,
  type FinanceBarAppendInput,
} from "../../src/agents/finance-bar-ledger.js";
import { readFinancePositionLedger } from "../../src/agents/finance-position-ledger.js";
import { resolveFinancePositionLedgerLocation } from "../../src/agents/finance-state-dir.js";

const USAGE =
  "Usage: node --import tsx scripts/operator/lcx-finance-bar-ledger.ts [--json] " +
  "[--dir PATH] [--append FILE] [--from-marks] [--instrument SYM] [--as-of ISO]";

type Options = Readonly<{
  json: boolean;
  directory?: string;
  append?: string;
  fromMarks: boolean;
  instrument?: string;
  asOf?: string;
}>;

function parseArgs(argv: readonly string[]): Options {
  const options: {
    json: boolean;
    directory?: string;
    append?: string;
    fromMarks: boolean;
    instrument?: string;
    asOf?: string;
  } = { json: false, fromMarks: false };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--dir") {
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${USAGE}\n--dir requires a path`);
      }
      options.directory = next;
      index += 1;
    } else if (arg === "--append") {
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${USAGE}\n--append requires a file`);
      }
      options.append = next;
      index += 1;
    } else if (arg === "--from-marks") {
      options.fromMarks = true;
    } else if (arg === "--instrument") {
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${USAGE}\n--instrument requires a symbol`);
      }
      options.instrument = next;
      index += 1;
    } else if (arg === "--as-of") {
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${USAGE}\n--as-of requires an ISO timestamp`);
      }
      options.asOf = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(USAGE);
    } else {
      throw new Error(`${USAGE}\nunknown argument: ${String(arg)}`);
    }
    index += 1;
  }
  return options;
}

/**
 * Build a `point_derived` batch from marks already recorded in the position ledger.
 *
 * This is the only write path reachable without a market data credential, which is why it exists
 * as a first-class command rather than something the caller is expected to script. It does not
 * invent a range: each bar carries the number of observations behind it, and a bar produced from
 * one observation has `high === low` — an unknown range, not a zero one.
 */
async function buildFromMarks(options: Options, directory: string): Promise<FinanceBarAppendInput> {
  if (options.instrument === undefined || options.instrument.length === 0) {
    throw new Error("--from-marks requires --instrument SYM to say which marks to derive from");
  }
  const read = await readFinancePositionLedger(
    directory,
    options.asOf === undefined || options.asOf.length === 0 ? {} : { asOf: options.asOf },
  );
  const marks = read.marks.filter((mark) => mark.instrument === options.instrument);
  if (marks.length === 0) {
    throw new Error(
      `no marks recorded for ${options.instrument}; --from-marks can only derive from ` +
        `observations that already exist, and it will not fabricate them`,
    );
  }
  // The batch's clock is the newest source observation, not the moment this command ran.
  //
  // A derived batch adds no information that its sources did not already carry, so its
  // observation time is the newest mark it was derived from. Using the wall clock instead would
  // make the batch invisible to every `asOf` earlier than now — and the readiness judgement,
  // which replays a past window, would then see a book with bars in it as a book with none.
  // That is the failure this line exists to prevent: reading "no bars" as "no history".
  const observedAt = marks.reduce(
    (latest, mark) => (mark.at > latest ? mark.at : latest),
    marks[0].at,
  );
  return {
    instrument: options.instrument,
    derivation: "point_derived",
    provenance: {
      origin: "lcx_position_ledger_marks",
      sourceUrlOrArtifact: "finance_position_records",
      note: `derived from ${String(marks.length)} mark observation(s) already in the position book`,
    },
    observedAt,
    // The instrument belongs to the batch, not to the point: the ledger derives it from the batch,
    // so a point cannot be filed under an instrument other than the one its provenance names.
    points: marks.map((mark) => ({
      date: mark.at.slice(0, 10),
      price: mark.price,
      at: mark.at,
    })),
  };
}

function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function renderText(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("Bar book");
  const directory = payload["ledgerDirectory"];
  if (typeof directory === "string") {
    lines.push(`  目录: ${directory}`);
  }
  const present = payload["databasePresent"];
  if (present !== undefined) {
    lines.push(`  库存在: ${text(present)}`);
  }
  const recordCount = payload["recordCount"];
  if (recordCount !== undefined) {
    lines.push(`  批次数: ${text(recordCount)}`);
  }
  const barCount = payload["barCount"];
  if (barCount !== undefined) {
    lines.push(`  bar 数: ${text(barCount)}`);
  }
  const singleSample = payload["singleSampleBarCount"];
  if (singleSample !== undefined) {
    lines.push(`  单点样本 bar 数（区间未知）: ${text(singleSample)}`);
  }
  const divergent = payload["divergentDates"];
  if (Array.isArray(divergent) && divergent.length > 0) {
    lines.push(`  来源分歧 instrument@date: ${divergent.join(", ")}`);
  }
  const derived = payload["derived"];
  if (derived !== undefined) {
    lines.push(`  派生自点观测: ${text(derived)}`);
  }
  const append = payload["append"];
  if (typeof append === "object" && append !== null) {
    const row = append as Record<string, unknown>;
    lines.push(`  追加: appended=${text(row["appended"])} bars=${text(row["barCount"])}`);
  }
  const error = payload["error"];
  if (error !== undefined) {
    lines.push(`  错误: ${text(error)}`);
  }
  lines.push("边界：只读写本地 SQLite 账本；不读凭据、不联网、不下单。");
  return lines.join("\n");
}

export async function runBarLedger(argv: readonly string[]): Promise<Record<string, unknown>> {
  const options = parseArgs(argv);
  const location = resolveFinancePositionLedgerLocation(
    options.directory === undefined ? {} : { directory: options.directory },
  );
  const base = {
    ledgerDirectory: location.directory,
    resolvedFrom: location.source,
  };

  try {
    let append: Record<string, unknown> | undefined;
    let derived: boolean | undefined;

    if (options.append !== undefined) {
      const parsed: unknown = JSON.parse(await fs.readFile(options.append, "utf8"));
      const result = await appendFinanceBars(location.directory, parsed as FinanceBarAppendInput);
      append = {
        appended: result.appended,
        recordCount: result.recordCount,
        barCount: result.record.body.bars.length,
        derivation: result.record.body.derivation,
        headRef: result.headRef,
      };
      derived = result.record.body.derivation === "point_derived";
    } else if (options.fromMarks) {
      const input = await buildFromMarks(options, location.directory);
      const result = await appendFinanceBars(location.directory, input);
      append = {
        appended: result.appended,
        recordCount: result.recordCount,
        barCount: result.record.body.bars.length,
        derivation: result.record.body.derivation,
        headRef: result.headRef,
      };
      derived = true;
    }

    const present = await financeBarLedgerExists(location.directory);
    const ledger = await readFinanceBarLedger(location.directory, {
      ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
      ...(options.instrument === undefined ? {} : { instrument: options.instrument }),
    });
    const singleSampleBarCount = ledger.bars.filter((bar) => bar.sampleCount === 1).length;

    const payload: Record<string, unknown> = {
      ...base,
      ok: true,
      databasePresent: present,
      recordCount: ledger.recordCount,
      barCount: ledger.bars.length,
      singleSampleBarCount,
      divergentDates: [...ledger.divergentDates],
      rangeUsableBarCount: ledger.bars.length - singleSampleBarCount,
      headRef: ledger.headRef,
      // Same guard the position ledger uses: writing to a location nobody named is how a book
      // gets filled in the wrong place, and a wrong-but-existing book reads as an empty one.
      directorySourceNotice:
        append?.appended === true && location.source !== "explicit"
          ? `wrote to the ${location.source} location rather than one named with --dir; pass --dir or ` +
            "set LCX_FINANCE_STATE_DIR if this is not the book you meant"
          : null,
      ...(append === undefined ? {} : { append }),
      ...(derived === undefined ? {} : { derived }),
      bars: ledger.bars,
      note:
        "A bar with sampleCount 1 has high === low: its intraday range is unknown, not zero. " +
        "Range-based measures (true drawdown, ATR, support/resistance) are only meaningful over " +
        "the rangeUsableBarCount bars that have more than one observation behind them.",
    };
    if (!options.json) {
      process.stdout.write(`${renderText(payload)}\n`);
    }
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const payload = { ...base, ok: false, error: message };
    if (!options.json) {
      process.stdout.write(`${renderText(payload)}\n`);
    }
    return payload;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes("--json");
  const payload = await runBarLedger(argv);
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
  if (payload["ok"] === false) {
    process.exitCode = 1;
  }
}
