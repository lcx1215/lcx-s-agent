import { Type } from "@sinclair/typebox";
import {
  appendFinanceBars,
  readFinanceBarLedger,
  type FinanceBarAppendInput,
} from "../finance-bar-ledger.js";
import { resolveFinanceBarLedgerLocation } from "../finance-state-dir.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

export const FINANCE_BAR_LEDGER_SCHEMA_VERSION = "lcx_finance_bar_ledger_tool_v1" as const;

/**
 * The batch shape is stated here rather than left as a free-form object, so the model can see what
 * to pass. It is deliberately kept structurally identical to the ledger's own `ohlcv` batch: the
 * payload an MCP bar source returns can be handed over unchanged, and every re-shaping step is a
 * place for the two to drift apart.
 */
const BarSchema = Type.Object({
  date: Type.String({ description: "Calendar day, YYYY-MM-DD." }),
  open: Type.Number(),
  high: Type.Number(),
  low: Type.Number(),
  close: Type.Number(),
  volume: Type.Optional(Type.Number()),
});

const BatchSchema = Type.Object({
  instrument: Type.String({ description: "Instrument key, e.g. 600519.SH." }),
  derivation: Type.Literal("ohlcv"),
  provenance: Type.Object({
    origin: Type.String({ description: "Where the bars came from, e.g. tencent-gtimg-qfq-day." }),
    sourceUrlOrArtifact: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
  }),
  observedAt: Type.String({ description: "ISO datetime at which the batch was observed." }),
  bars: Type.Array(BarSchema, { minItems: 1 }),
});

const FinanceBarLedgerSchema = Type.Object({
  action: stringEnum(["append", "read"]),
  directory: Type.Optional(
    Type.String({
      description:
        "Ledger directory. Defaults to LCX_FINANCE_STATE_DIR, then <workspace>/state/finance.",
    }),
  ),
  batch: Type.Optional(BatchSchema),
  instrument: Type.Optional(Type.String({ description: "Read filter: instrument key." })),
  asOf: Type.Optional(
    Type.String({ description: "Read filter: ISO datetime; batches observed later are excluded." }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Read cap on returned bars (default 200). Newest last." }),
  ),
});

const DEFAULT_LIMIT = 200;

/**
 * The agent's own bar book: append a batch, or read what is recorded.
 *
 * Before this tool the bar ledger was unreachable from the agent's side — bars could only be
 * appended by an operator script, so no answer could depend on price history the system already
 * held. "Can the agent read its own book" is the falsifiable test that a store is actually wired
 * in rather than merely present on disk.
 *
 * It reports `ledgerDirectory` and `resolvedFrom` on every call. Reading the wrong directory is
 * silent: an absent book and a book with no bars for this instrument look identical, and the only
 * way to tell them apart is to say which path was read.
 */
export function createFinanceBarLedgerTool(options?: { workspaceDir?: string }): AnyAgentTool {
  return {
    label: "Finance Bar Ledger",
    name: "finance_bar_ledger",
    description:
      "Append a daily OHLCV batch to the agent's own bar book, or read the bars already recorded. Append-only and idempotent: the identical batch is not recorded twice. Every batch carries provenance, and bars are stored with their derivation so a range built from point observations is never read as an exchange-aggregated range. Use read before any answer that depends on price history the system holds; use append after fetching bars from a source (for example an MCP bar server). Research-only: it places no order and has no execution authority.",
    parameters: FinanceBarLedgerSchema,
    execute: async (_toolCallId, args) => {
      const params = args as {
        action: "append" | "read";
        directory?: string;
        batch?: unknown;
        instrument?: string;
        asOf?: string;
        limit?: number;
      };
      const location = resolveFinanceBarLedgerLocation({
        workspaceDir: options?.workspaceDir,
        ...(params.directory ? { directory: params.directory } : {}),
      });

      if (params.action === "append") {
        if (!params.batch) {
          return jsonResult({
            ok: false,
            schemaVersion: FINANCE_BAR_LEDGER_SCHEMA_VERSION,
            reason: "finance_bar_ledger_batch_required",
            action: "Pass the batch exactly as the source returned it; do not re-shape it.",
            ledgerDirectory: location.directory,
            resolvedFrom: location.source,
          });
        }
        try {
          const appended = await appendFinanceBars(
            location.directory,
            params.batch as FinanceBarAppendInput,
          );
          const recorded = appended.record.body.bars;
          const firstBar = recorded[0];
          const lastBar = recorded.at(-1);
          return jsonResult({
            ok: true,
            schemaVersion: FINANCE_BAR_LEDGER_SCHEMA_VERSION,
            boundary: "finance_bar_ledger_research_only",
            status: "recorded",
            ledgerDirectory: location.directory,
            resolvedFrom: location.source,
            databasePath: location.database,
            instrument: appended.record.body.instrument,
            derivation: appended.record.body.derivation,
            barCount: recorded.length,
            // The schema guarantees at least one bar; reading it defensively keeps the range a
            // string-or-null rather than a crash if that guarantee ever loosens.
            range: firstBar && lastBar ? `${firstBar.date}..${lastBar.date}` : null,
            // An identical batch is not a failure, but it is also not new evidence; saying which
            // one happened keeps "appended nothing" from being read as "appended successfully".
            appended: appended.appended,
            // How much of the submitted batch was already on file. A daily full-history collection
            // is almost entirely repeats, so without this an operator cannot tell "filed 6464 bars"
            // from "filed today's one bar and skipped the 6463 we already had".
            repeatsSkipped: appended.repeatsSkipped,
            recordCount: appended.recordCount,
            headRef: appended.headRef,
            nextTool:
              "finance_bar_ledger with action=read, or finance_chart_analysis over the bars",
            notTouched: [
              "trading_execution",
              "order_placement",
              "provider_config",
              "protected_memory",
            ],
          });
        } catch (error) {
          return jsonResult({
            ok: false,
            schemaVersion: FINANCE_BAR_LEDGER_SCHEMA_VERSION,
            boundary: "finance_bar_ledger_research_only",
            reason: "finance_bar_ledger_append_rejected",
            // The ledger already names the offending field path; surfacing it verbatim is the
            // whole value of the error.
            error: error instanceof Error ? error.message : String(error),
            ledgerDirectory: location.directory,
            resolvedFrom: location.source,
          });
        }
      }

      const ledger = await readFinanceBarLedger(location.directory, {
        ...(params.instrument ? { instrument: params.instrument } : {}),
        ...(params.asOf ? { asOf: params.asOf } : {}),
      });
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
          ? Math.floor(params.limit)
          : DEFAULT_LIMIT;
      const bars = ledger.bars.slice(-limit);

      // The assembly point between the book and chart analysis — and the place where the book's
      // central distinction has to be enforced rather than documented. A `point_derived` bar's
      // high/low are only the extremes that happened to be observed, so feeding one to ATR,
      // drawdown or support/resistance silently understates every range measure. Refusing to
      // produce chart input is what keeps that from happening by accident; a caller that still
      // wants the close series has it in `bars` and can say so.
      const derivedBars = bars.filter((bar) => bar.sampleCount !== null);
      const chartBars =
        derivedBars.length === 0
          ? bars.map((bar) => ({
              date: bar.date,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              ...(bar.volume !== undefined ? { volume: bar.volume } : {}),
            }))
          : null;

      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_BAR_LEDGER_SCHEMA_VERSION,
        boundary: "finance_bar_ledger_read_only",
        status:
          ledger.recordCount === 0
            ? "absent"
            : ledger.bars.length === 0
              ? "empty_for_filter"
              : "ready",
        ledgerDirectory: location.directory,
        resolvedFrom: location.source,
        databasePath: location.database,
        // Said explicitly because the two cases look the same and mean opposite things: an absent
        // book is missing supply, an empty-for-filter book has supply but none for this instrument.
        statusMeaning:
          ledger.recordCount === 0
            ? "no bars have ever been recorded in this directory"
            : ledger.bars.length === 0
              ? "bars exist but none match the supplied instrument/asOf filter"
              : "bars are available",
        asOf: params.asOf ?? null,
        instrument: params.instrument ?? null,
        recordCount: ledger.recordCount,
        totalBarCount: ledger.bars.length,
        // Exact replays of a day (overlapping collection windows) are collapsed before counting:
        // a duplicated day is a zero-return day, which deflates every range and volatility
        // measure taken from this series. Reported so the collapse is visible, not silent.
        ...(ledger.collapsedRepeats > 0
          ? {
              repeatedBarsCollapsed: ledger.collapsedRepeats,
              repeatedBarsCollapsedNote:
                `${ledger.collapsedRepeats} bar(s) were exact replays of a day already in the book ` +
                "(same instrument, date, OHLCV and volume) and were collapsed; counting them twice " +
                "would add zero-return days and understate volatility and range measures.",
            }
          : {}),
        returnedBarCount: bars.length,
        ...(bars.length < ledger.bars.length
          ? { truncated: true, hint: `showing the last ${limit}; raise limit for the full series` }
          : {}),
        bars,
        // Shaped exactly for `finance_chart_analysis`'s `bars` parameter: that schema is a closed
        // object, so the ledger's own `instrument` and `sampleCount` fields would be rejected —
        // which is why this conversion lives here rather than being left to the caller.
        chartBars,
        chartBarsUnavailableReason:
          chartBars === null
            ? `${derivedBars.length} of ${bars.length} bars are point_derived: high/low are only the extremes that were observed, so ATR, max drawdown and support/resistance would be understated. Do not pass them to finance_chart_analysis as if they were exchange-aggregated.`
            : null,
        ...(bars.length > 250
          ? { chartNote: "finance_chart_analysis accepts at most 250 bars; lower limit if needed" }
          : {}),
        // Two sources observing the same instrument-date with different closes is a fact about the
        // sources, not an error to collapse.
        divergentDates: ledger.divergentDates,
        headRef: ledger.headRef,
        nextTool:
          ledger.bars.length === 0
            ? undefined
            : chartBars === null
              ? "finance_bar_ledger action=append with exchange-aggregated bars before analysing ranges"
              : "finance_chart_analysis with bars=chartBars",
        notTouched: ["trading_execution", "order_placement", "provider_config", "protected_memory"],
      });
    },
  };
}
