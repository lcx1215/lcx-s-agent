#!/usr/bin/env node

import {
  createFinanceMarketCollectionRegistry,
  FINANCE_MARKET_COLLECTION_KINDS,
  resolveFinanceMarketCollectionRegistryOptionsFromEnv,
  runFinanceMarketCollectionRefresh,
  type FinanceMarketCollectionKind,
} from "../../src/agents/finance-market-collection-registry.ts";

function parseArgs(args: string[]) {
  const valueAfter = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const collection = (valueAfter("--collection") ?? "news") as FinanceMarketCollectionKind;
  const instrument = (valueAfter("--symbol") ?? valueAfter("--instrument") ?? "AAPL").toUpperCase();
  const seriesId = valueAfter("--series-id");
  const limitValue = Number(valueAfter("--limit") ?? "20");
  return {
    live: args.includes("--live"),
    json: args.includes("--json"),
    collection,
    instrument,
    seriesId,
    limit: Number.isInteger(limitValue) && limitValue > 0 ? limitValue : 20,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!(FINANCE_MARKET_COLLECTION_KINDS as readonly string[]).includes(options.collection)) {
    process.stderr.write(
      `collection must be one of: ${FINANCE_MARKET_COLLECTION_KINDS.join(", ")}\n`,
    );
    return 2;
  }
  if (!options.live) {
    process.stdout.write(
      [
        "us-market-collection-live-smoke: dry mode (no network fetch).",
        "Pass --live to fetch a structured collection through the canonical registry.",
        "Examples:",
        "  --live --collection news --symbol AAPL --json",
        "  --live --collection options_chain --symbol AAPL --json",
        "  --live --collection macro_series --series-id CUSR0000SA0 --json",
        "Boundary: research-only; no trade, order, broker, or wallet authority.",
      ].join("\n"),
    );
    process.stdout.write("\n");
    return 0;
  }
  const request = {
    instrument: options.seriesId ?? options.instrument,
    assetClass: options.collection === "macro_series" ? "macro_series" : "us_equity",
    collection: options.collection,
    seriesId: options.seriesId,
    asOf: new Date().toISOString(),
    limit: options.limit,
  } as const;
  const receipt = await runFinanceMarketCollectionRefresh({
    request,
    adapters: createFinanceMarketCollectionRegistry(
      resolveFinanceMarketCollectionRegistryOptionsFromEnv(),
    ),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `collection=${receipt.request.collection}`,
        `instrument=${receipt.request.instrument}`,
        `status=${receipt.status}`,
        `records=${receipt.records.length}`,
        `sourceAttempts=${receipt.sourceAttempts.map((attempt) => `${attempt.adapterId}:${attempt.status}`).join(",") || "none"}`,
        `missingEvidence=${receipt.missingEvidence.join(",") || "none"}`,
      ].join("\n"),
    );
    process.stdout.write("\n");
  }
  return receipt.status === "blocked" ? 2 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`collection_live_smoke_error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
