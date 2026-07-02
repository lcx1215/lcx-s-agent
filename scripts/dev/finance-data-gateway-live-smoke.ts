#!/usr/bin/env node
// Live counterpart to finance-data-gateway-smoke.ts.
//
// The fixture smoke proves the gateway's validation logic offline. This live
// smoke proves the NEW path: fetch a real quote from an authorized public
// source (Stooq, delayed/EOD) and feed it into the same pure gateway.
//
// It is fail-closed and opt-in: the real network fetch only runs with --live.
// Without --live it prints how to enable it and exits 0 (no silent fake data).
//
// Usage:
//   node --import tsx scripts/dev/finance-data-gateway-live-smoke.ts            # dry, prints guidance
//   node --import tsx scripts/dev/finance-data-gateway-live-smoke.ts --live     # real fetch
//   node --import tsx scripts/dev/finance-data-gateway-live-smoke.ts --live --symbol SPY --json

import { buildFinanceDataGatewaySnapshot } from "../../src/agents/finance-data-gateway.ts";
import { collectLiveFinanceGatewayInput } from "../../src/agents/finance-live-market-source.ts";

function parseArgs(args: string[]) {
  const symbolFlagIndex = args.indexOf("--symbol");
  const symbol =
    symbolFlagIndex >= 0 && args[symbolFlagIndex + 1] ? args[symbolFlagIndex + 1] : "QQQ";
  return {
    json: args.includes("--json"),
    live: args.includes("--live"),
    symbol: symbol.toUpperCase(),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.live) {
    process.stdout.write(
      [
        "finance-data-gateway-live-smoke: dry mode (no network fetch).",
        "Pass --live to fetch a real delayed/EOD quote from the public source.",
        "Example: node --import tsx scripts/dev/finance-data-gateway-live-smoke.ts --live --symbol QQQ --json",
        "Boundary: research-only, delayed data, single primary source -> gateway will report blocked",
        "until a real cross-check + official/issuer provider are added.",
      ].join("\n"),
    );
    process.stdout.write("\n");
    return 0;
  }

  let input;
  try {
    input = await collectLiveFinanceGatewayInput({
      instrument: options.symbol,
      assetClass: "etf",
      useCase: "live_gateway_smoke_portfolio_macro_risk_research",
      requireOfficialReference: false,
      freshnessMaxMinutes: 60 * 24 * 5,
    });
  } catch (error) {
    // Fail closed: a live source that is unavailable must not produce a fake or
    // empty snapshot. Report the honest failure and exit non-zero.
    process.stderr.write(
      `live_fetch_failed reason=${(error as { reason?: string }).reason ?? "unknown"}: ${
        (error as Error).message
      }\n`,
    );
    return 2;
  }

  const snapshot = buildFinanceDataGatewaySnapshot(input);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } else {
    const priceField = snapshot.normalizedFields.find((field) => field.name === "last_price");
    process.stdout.write(
      [
        `instrument=${snapshot.instrument}`,
        `live=true source=yahoo`,
        `ok=${snapshot.ok}`,
        `qualityStatus=${snapshot.qualityStatus}`,
        `last_price=${priceField?.value ?? "none"}`,
        `sourceTimestamp=${priceField?.sourceTimestamp ?? "none"}`,
        `providerRoles=${snapshot.providerRolesPresent.join(",")}`,
        `missingEvidence=${snapshot.missingEvidence.join(",") || "none"}`,
      ].join("\n"),
    );
    process.stdout.write("\n");
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`live_smoke_error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
