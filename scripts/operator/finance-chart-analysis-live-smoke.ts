#!/usr/bin/env node

import { createFinanceChartAnalysisTool } from "../../src/agents/tools/finance-chart-analysis-tool.ts";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArgs(args: string[]) {
  const limit = Number(valueAfter(args, "--limit") ?? "250");
  return {
    instrument: valueAfter(args, "--symbol") ?? valueAfter(args, "--instrument") ?? "AAPL",
    fromDate: valueAfter(args, "--from-date"),
    toDate: valueAfter(args, "--to-date"),
    limit: Number.isInteger(limit) && limit >= 2 ? Math.min(250, limit) : 250,
    image: valueAfter(args, "--image"),
    liveFetch: args.includes("--live"),
    writeReceipt: args.includes("--write"),
    json: args.includes("--json"),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tool = createFinanceChartAnalysisTool();
  const result = await tool.execute("finance-chart-analysis-cli", options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.details, null, 2)}\n`);
    return 0;
  }
  const details = result.details as {
    instrument?: string;
    status?: string;
    normalizedBarCount?: number;
    analysis?: {
      features?: { trendDirection?: string; totalReturnPct?: number; maxDrawdownPct?: number };
    } | null;
    sourceReceipt?: { selectedSourceIds?: readonly string[]; status?: string };
    visual?: { imageAttached?: boolean; imageError?: string };
    receiptPath?: string;
  };
  const features = details.analysis?.features;
  process.stdout.write(
    [
      `instrument=${details.instrument ?? options.instrument}`,
      `status=${details.status ?? "unknown"}`,
      `sourceStatus=${details.sourceReceipt?.status ?? "unknown"}`,
      `sources=${details.sourceReceipt?.selectedSourceIds?.join(",") || "none"}`,
      `bars=${details.normalizedBarCount ?? 0}`,
      `trend=${features?.trendDirection ?? "unavailable"}`,
      `totalReturnPct=${features?.totalReturnPct?.toFixed(2) ?? "unavailable"}`,
      `maxDrawdownPct=${features?.maxDrawdownPct?.toFixed(2) ?? "unavailable"}`,
      `imageAttached=${details.visual?.imageAttached ?? false}`,
      `imageError=${details.visual?.imageError ?? "none"}`,
      `receiptPath=${details.receiptPath ?? "none"}`,
      "Boundary: deterministic chart research only; no trade, order, sizing, broker, wallet, or sender authority.",
    ].join("\n") + "\n",
  );
  return details.status === "blocked" ? 2 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`finance_chart_analysis_error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
