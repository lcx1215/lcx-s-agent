#!/usr/bin/env node

import {
  createResearchDataAutopilotTool,
  RESEARCH_DATA_AUTOPILOT_INTENTS,
} from "../../src/agents/tools/research-data-autopilot-tool.ts";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArgs(args: string[]) {
  const intent = valueAfter(args, "--intent") ?? "news";
  const target = valueAfter(args, "--target") ?? valueAfter(args, "--symbol") ?? "AAPL";
  const limitValue = Number(valueAfter(args, "--limit") ?? "20");
  return {
    intent,
    target,
    assetClass: valueAfter(args, "--asset-class"),
    seriesId: valueAfter(args, "--series-id"),
    fromDate: valueAfter(args, "--from-date"),
    toDate: valueAfter(args, "--to-date"),
    limit: Number.isInteger(limitValue) && limitValue > 0 ? limitValue : 20,
    liveFetch: args.includes("--live"),
    json: args.includes("--json"),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!(RESEARCH_DATA_AUTOPILOT_INTENTS as readonly string[]).includes(options.intent)) {
    process.stderr.write(`intent must be one of: ${RESEARCH_DATA_AUTOPILOT_INTENTS.join(", ")}\n`);
    return 2;
  }
  const tool = createResearchDataAutopilotTool();
  const result = await tool.execute("research-data-autopilot-cli", {
    intent: options.intent,
    target: options.target,
    assetClass: options.assetClass,
    seriesId: options.seriesId,
    fromDate: options.fromDate,
    toDate: options.toDate,
    limit: options.limit,
    liveFetch: options.liveFetch,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.details, null, 2)}\n`);
    return 0;
  }
  const details = result.details as {
    intent: string;
    target: string;
    liveFetch: boolean;
    result?: {
      status?: string;
      candidateAdapters?: readonly unknown[];
      selectedSourceIds?: readonly string[];
      records?: readonly unknown[];
      observations?: readonly unknown[];
      sourceAttempts?: readonly unknown[];
    };
  };
  process.stdout.write(
    [
      `intent=${details.intent}`,
      `target=${details.target}`,
      `liveFetch=${details.liveFetch}`,
      `status=${details.result?.status ?? "inspection"}`,
      `candidateAdapters=${details.result?.candidateAdapters?.length ?? 0}`,
      `selectedSources=${details.result?.selectedSourceIds?.join(",") || "none"}`,
      `records=${details.result?.records?.length ?? details.result?.observations?.length ?? 0}`,
      `sourceAttempts=${details.result?.sourceAttempts?.length ?? 0}`,
      "Boundary: research-only; no trade, order, broker, wallet, or sender authority.",
    ].join("\n") + "\n",
  );
  return details.result?.status === "blocked" ? 2 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`research_data_autopilot_error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
