#!/usr/bin/env -S node --import tsx
/**
 * Paper-loop analysis lane for the scheduler.
 *
 * The governance cycle (`agent-system-loop-smoke.ts`) is contractually a
 * *clean* cycle: the watchdog requires `remoteFetchOccurred === false`, because
 * a governance cycle must not reach the network. The trading analysis cannot
 * honour that contract -- fetching market data is the whole point of it.
 *
 * So this is a separate lane with its own, declared boundary:
 *   - remoteFetchOccurred: true      market data only (Deribit / Hyperliquid)
 *   - liveTouched: false             no live account, no keys
 *   - executionAuthorityGranted: false  paper only, never places an order
 *
 * Reporting `remoteFetchOccurred: false` here would be a lie, and reporting
 * `true` on the governance lane would (correctly) trip the watchdog. Keeping
 * the two lanes apart is what lets both stay honest.
 *
 * Emits the scheduler envelope on stdout and writes the paper-loop artifact.
 */

import { pathToFileURL } from "node:url";
import {
  formatPaperReportLines,
  runPaperReport,
  type PaperReport,
} from "../../paper-loop/report.ts";

export type AnalysisCycleEnvelope = {
  ok: boolean;
  status: "passed" | "failed";
  scope: string;
  checkCount: number;
  checks: Array<{ name: string; ok: boolean; durationMs: number; summary: string }>;
  /** Wall-clock time for the whole lane, matching the governance cycle envelope. */
  durationMs: number;
  liveTouched: boolean;
  providerConfigTouched: boolean;
  protectedMemoryTouched: boolean;
  /** Declared true: the analysis reads public market data. */
  remoteFetchOccurred: boolean;
  executionAuthorityGranted: boolean;
  summary: string;
};

export function buildAnalysisEnvelope(
  report: PaperReport,
  durationMs: number,
): AnalysisCycleEnvelope {
  const measured = report.analyses.filter((entry) => entry.ok).length;
  const failed = report.analyses.length - measured;
  const { edgeCount, liquidatedIsolated, conclusion } = report.summary;

  const checks = report.analyses.map((entry) => ({
    name: entry.ok
      ? `${entry.kind}:${entry.analysis.kind === "carry" ? `${entry.analysis.venue}/${entry.analysis.instrument}` : `${entry.analysis.symbols.length} symbols`}`
      : `${entry.kind}:${entry.target}`,
    ok: entry.ok,
    durationMs: 0,
    summary: entry.ok ? entry.analysis.verdictCode : `FAILED: ${entry.error}`.slice(0, 200),
  }));

  return {
    ok: measured > 0,
    status: measured > 0 ? "passed" : "failed",
    scope: "paper_loop_trading_analysis",
    checkCount: checks.length,
    checks,
    durationMs,
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
    remoteFetchOccurred: true,
    executionAuthorityGranted: false,
    summary:
      `${measured}/${report.analyses.length} analyses measured (${failed} failed); ` +
      `${edgeCount} EDGE, ${liquidatedIsolated} of them liquidated on isolated margin. ` +
      conclusion,
  };
}

async function main(): Promise<void> {
  const quick = process.argv.includes("--quick");
  const startedAt = Date.now();
  let report: PaperReport;
  try {
    report = await runPaperReport({ quick });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          status: "failed",
          scope: "paper_loop_trading_analysis",
          checkCount: 0,
          checks: [],
          durationMs: Date.now() - startedAt,
          liveTouched: false,
          providerConfigTouched: false,
          protectedMemoryTouched: false,
          remoteFetchOccurred: true,
          executionAuthorityGranted: false,
          summary: `analysis lane failed before producing a report: ${message}`.slice(0, 500),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const envelope = buildAnalysisEnvelope(report, Date.now() - startedAt);
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  for (const line of formatPaperReportLines(report)) {
    process.stderr.write(`${line}\n`);
  }
  process.stderr.write(`  ${report.summary.conclusion}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
