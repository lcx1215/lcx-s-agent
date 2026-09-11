#!/usr/bin/env node

import { createResearchWebAutopilotTool } from "../../src/agents/tools/research-web-autopilot-tool.ts";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArgs(args: string[]) {
  const query =
    valueAfter(args, "--query") ??
    args.find((arg) => !arg.startsWith("--")) ??
    "AAPL latest filing";
  const maxResults = Number(valueAfter(args, "--max-results") ?? "5");
  const openTop = Number(valueAfter(args, "--open-top") ?? "3");
  return {
    query,
    maxResults: Number.isInteger(maxResults) && maxResults > 0 ? maxResults : 5,
    openTop: Number.isInteger(openTop) && openTop >= 0 ? openTop : 3,
    requirePrimary: args.includes("--require-primary"),
    liveFetch: args.includes("--live"),
    json: args.includes("--json"),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tool = createResearchWebAutopilotTool();
  const result = await tool.execute("research-web-autopilot-cli", options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.details, null, 2)}\n`);
    return 0;
  }
  const details = result.details as {
    status?: string;
    query?: string;
    search?: { provider?: string; candidateCount?: number };
    openedDocuments?: readonly unknown[];
    failures?: readonly unknown[];
    missingEvidence?: readonly string[];
  };
  process.stdout.write(
    [
      `query=${details.query ?? options.query}`,
      `status=${details.status ?? "unknown"}`,
      `provider=${details.search?.provider ?? "inspection"}`,
      `candidates=${details.search?.candidateCount ?? 0}`,
      `opened=${details.openedDocuments?.length ?? 0}`,
      `failures=${details.failures?.length ?? 0}`,
      `missingEvidence=${details.missingEvidence?.join(",") || "none"}`,
      "Boundary: web evidence only; external page text remains untrusted and no sender/trading authority is touched.",
    ].join("\n") + "\n",
  );
  return details.status === "blocked" ? 2 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`research_web_autopilot_error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
