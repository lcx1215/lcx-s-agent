#!/usr/bin/env -S node --import tsx
/**
 * Paper-loop report: the single entry point the system runs to produce its own
 * trading analysis.
 *
 * It runs every configured analysis, collects the verdicts, and writes one
 * machine-readable artifact. Nothing here is hand-assembled: the numbers and
 * the verdicts come from the analyses themselves, so any agent or operator
 * reading the artifact sees exactly what the measurement produced, including
 * the ones that failed to find an edge.
 *
 * `runPaperReport` is the reusable capability. Callers that need the report as
 * a value (the scheduler analysis lane, tests) import it; the CLI below is just
 * one caller of it.
 *
 * Output:
 *   branches/_system/paper-loop/report.json   (machine-readable, the artifact)
 *   stdout                                    (compact human summary, or JSON)
 *
 * Usage:
 *   node --import tsx paper-loop/report.ts
 *   node --import tsx paper-loop/report.ts --json
 *   node --import tsx paper-loop/report.ts --quick      # shorter window, faster
 *   node --import tsx paper-loop/report.ts --spot-leverage 3   # lever the spot leg
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  runCarryAnalysis,
  type CarryAnalysis,
  type CarryParams,
  type CarryVenue,
} from "./carry.ts";
import { runTrendAnalysis, pct, type TrendAnalysis } from "./loop.ts";

const REPORT_PATH = resolve("branches/_system/paper-loop/report.json");

export const DEFAULT_TREND_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "LINKUSDT",
];

/** Venue/instrument pairs worth measuring. Deribit is low-yield; Hyperliquid is not. */
export const DEFAULT_CARRY_TARGETS: Array<{ venue: CarryVenue; instrument: string }> = [
  { venue: "hyperliquid", instrument: "BTC" },
  { venue: "hyperliquid", instrument: "ETH" },
  { venue: "hyperliquid", instrument: "SOL" },
  { venue: "deribit", instrument: "BTC-PERPETUAL" },
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

type AnalysisEntry =
  | { kind: "trend"; ok: true; analysis: TrendAnalysis }
  | { kind: "carry"; ok: true; analysis: CarryAnalysis }
  | { kind: "trend" | "carry"; ok: false; target: string; error: string };

export type PaperReport = {
  schemaVersion: 1;
  generatedAt: string;
  mode: "full" | "quick";
  analyses: AnalysisEntry[];
  summary: {
    measured: number;
    failed: number;
    edgeCount: number;
    noEdgeCount: number;
    /** How many of the profitable configurations die on isolated margin. */
    liquidatedIsolated: number;
    /** How many die because a levered spot leg is liquidated by a price fall. */
    spotLegLiquidated: number;
    edges: Array<{
      label: string;
      annualised: number | null;
      maxDrawdown: number;
      liquidatedIsolated: boolean;
      spotLegLiquidated: boolean;
      /** Gated return minus the operational overlay (collateral moves, rebalances). */
      netAfterOperationalCosts: number | null;
    }>;
    conclusion: string;
  };
};

export type PaperReportOptions = {
  quick: boolean;
  trendStart: string;
  trendBars: number;
  trendSymbols: string[];
  carryTargets: Array<{ venue: CarryVenue; instrument: string }>;
  /**
   * Overrides applied to every carry run, so the report-level CLI can exercise
   * the same knobs as `carry.ts` (e.g. `--spot-leverage`). Empty means the
   * engine defaults.
   */
  carryParams: Partial<CarryParams>;
  useCache: boolean;
  /** Write the artifact to disk. Defaults to true. */
  write: boolean;
};

export function defaultPaperReportOptions(quick: boolean): PaperReportOptions {
  return {
    quick,
    trendStart: quick ? "" : "2021-11-08",
    trendBars: quick ? 400 : 1800,
    trendSymbols: DEFAULT_TREND_SYMBOLS,
    carryTargets: DEFAULT_CARRY_TARGETS,
    carryParams: {},
    useCache: true,
    write: true,
  };
}

/**
 * Run every configured analysis and return the report.
 *
 * This is the system's own capability: an analysis failure is captured as a
 * failed entry rather than thrown, so one unreachable venue cannot hide the
 * rest of the measurement.
 */
export async function runPaperReport(
  overrides: Partial<PaperReportOptions> = {},
): Promise<PaperReport> {
  const opts: PaperReportOptions = { ...defaultPaperReportOptions(false), ...overrides };
  const entries: AnalysisEntry[] = [];

  try {
    const analysis = await runTrendAnalysis({
      symbols: opts.trendSymbols,
      bars: opts.trendBars,
      start: opts.trendStart || undefined,
      useCache: opts.useCache,
    });
    entries.push({ kind: "trend", ok: true, analysis });
  } catch (error) {
    entries.push({
      kind: "trend",
      ok: false,
      target: opts.trendSymbols.join(","),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  for (const target of opts.carryTargets) {
    const start = target.venue === "hyperliquid" ? "2023-05-12" : "2021-11-08";
    try {
      const analysis = await runCarryAnalysis({
        venue: target.venue,
        instrument: target.instrument,
        start: Date.parse(`${start}T00:00:00Z`),
        end: Date.now(),
        useCache: opts.useCache,
        params: opts.carryParams,
      });
      entries.push({ kind: "carry", ok: true, analysis });
    } catch (error) {
      entries.push({
        kind: "carry",
        ok: false,
        target: `${target.venue}/${target.instrument}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ok = entries.filter((e): e is Extract<AnalysisEntry, { ok: true }> => e.ok);
  const edges = ok
    .filter((e) => e.analysis.verdictCode === "EDGE")
    .map((e) => ({
      label:
        e.analysis.kind === "carry"
          ? `${e.analysis.venue}/${e.analysis.instrument} carry`
          : `trend ${e.analysis.symbols.length} symbols`,
      annualised: e.analysis.kind === "carry" ? e.analysis.gated.annualised : null,
      maxDrawdown:
        e.analysis.kind === "carry" ? e.analysis.gated.maxDrawdown : e.analysis.maxDrawdown,
      liquidatedIsolated:
        e.analysis.kind === "carry" ? e.analysis.liquidation.isolated.liquidated : false,
      spotLegLiquidated: e.analysis.kind === "carry" ? e.analysis.spotLeg.liquidated : false,
      netAfterOperationalCosts:
        e.analysis.kind === "carry" ? e.analysis.netAfterOperationalCosts : null,
    }));

  const liquidatedIsolated = edges.filter((e) => e.liquidatedIsolated).length;
  const spotLegLiquidated = edges.filter((e) => e.spotLegLiquidated).length;
  const noEdgeCount = ok.length - edges.length;
  const conclusion =
    ok.length === 0
      ? "No analysis completed; nothing can be concluded."
      : edges.length === 0
        ? "No measured configuration made money. Do not go live."
        : `${edges.length} of ${ok.length} measured configurations made money: ` +
          `${edges.map((e) => e.label).join(", ")}. ` +
          (liquidatedIsolated > 0
            ? `${liquidatedIsolated} of those ${edges.length} are LIQUIDATED under isolated margin, ` +
              "so they are only viable if the spot leg's gains can be posted as perp margin. "
            : "") +
          (spotLegLiquidated > 0
            ? `${spotLegLiquidated} die because the levered spot leg itself is liquidated. `
            : "") +
          "Read the per-analysis caveats before treating any of them as real.";

  const report: PaperReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: opts.quick ? "quick" : "full",
    analyses: entries,
    summary: {
      measured: ok.length,
      failed: entries.length - ok.length,
      edgeCount: edges.length,
      noEdgeCount,
      liquidatedIsolated,
      spotLegLiquidated,
      edges,
      conclusion,
    },
  };

  if (opts.write) {
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

/** One line per analysis, for console output and receipts. */
export function formatPaperReportLines(report: PaperReport): string[] {
  const lines: string[] = [];
  for (const entry of report.analyses) {
    if (!entry.ok) {
      lines.push(`  ${entry.kind.padEnd(5)} ${entry.target.padEnd(24)} FAILED: ${entry.error}`);
      continue;
    }
    const a = entry.analysis;
    if (a.kind === "carry") {
      const isolated = a.liquidation.isolated.liquidated ? "LIQUIDATED" : "survives";
      const spotLeg = a.spotLeg.liquidated ? "LIQUIDATED" : "survives";
      lines.push(
        `  carry ${`${a.venue}/${a.instrument}`.padEnd(24)} ` +
          `net ${pct(a.gated.netReturn).padStart(8)}  annual ${pct(a.gated.annualised).padStart(8)}  ` +
          `maxDD ${pct(a.gated.maxDrawdown).padStart(7)}  funding ${pct(a.meanFundingApr).padStart(8)} APR  ` +
          `${a.verdictCode.padEnd(8)}  isolated margin: ${isolated}`,
      );
      lines.push(
        `        spot leg ${a.params.spotLeverage}x: ${spotLeg} (max safe ` +
          `${a.spotLeg.maxSafeLeverage.toFixed(2)}x)  opcosts ${pct(a.costs.totalCost)} ` +
          `(${a.costs.collateralTransfers} collateral moves, ${a.costs.rebalances} rebalances)  ` +
          `net after opcosts ${pct(a.netAfterOperationalCosts)}`,
      );
    } else {
      lines.push(
        `  trend ${`${a.symbols.length} symbols`.padEnd(24)} ` +
          `net ${pct(a.totalReturn).padStart(8)}  benchmark ${pct(a.benchmark).padStart(8)}  ` +
          `capture ${a.capture.toFixed(2).padStart(6)}x  ${a.verdictCode}`,
      );
    }
  }
  return lines;
}

export { REPORT_PATH as PAPER_REPORT_PATH };

async function main(): Promise<void> {
  const quick = hasFlag("--quick");
  const spotLeverageRaw = arg("spot-leverage", "");
  const spotLeverage = Number(spotLeverageRaw);
  const report = await runPaperReport({
    ...defaultPaperReportOptions(quick),
    trendStart: arg("trend-start", quick ? "" : "2021-11-08"),
    trendBars: Number(arg("bars", quick ? "400" : "1800")),
    trendSymbols: arg("symbols", DEFAULT_TREND_SYMBOLS.join(","))
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    carryParams:
      spotLeverageRaw && Number.isFinite(spotLeverage) && spotLeverage > 0 ? { spotLeverage } : {},
    useCache: !hasFlag("--no-cache"),
  });

  if (hasFlag("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("paper-loop report: the system's own trading analysis\n");
  for (const line of formatPaperReportLines(report)) {
    console.log(line);
  }
  console.log(`\n  ${report.summary.conclusion}`);
  console.log(`  report written: ${REPORT_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
