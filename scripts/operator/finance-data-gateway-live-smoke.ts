#!/usr/bin/env node
// Live counterpart to finance-data-gateway-smoke.ts.
//
// The fixture smoke proves the gateway's validation logic offline. This live
// smoke proves the multi-source path: fetch public market data plus official
// references and feed every observation into the same canonical gateway.
//
// It is fail-closed and opt-in: the real network fetch only runs with --live.
// Without --live it prints how to enable it and exits 0 (no silent fake data).
//
// Usage:
//   node --import tsx scripts/operator/finance-data-gateway-live-smoke.ts            # dry, prints guidance
//   node --import tsx scripts/operator/finance-data-gateway-live-smoke.ts --live     # real fetch
//   node --import tsx scripts/operator/finance-data-gateway-live-smoke.ts --live --symbol SPY --json
//   node --import tsx scripts/operator/finance-data-gateway-live-smoke.ts --live --asset-class crypto --symbol BTCUSDT --json

import {
  createFinanceRealtimeSourceRegistry,
  resolveFinanceRealtimeSourceRegistryOptionsFromEnv,
  runFinanceRealtimeRefresh,
} from "../../src/agents/finance-realtime-source-registry.ts";

function parseArgs(args: string[]) {
  const symbolFlagIndex = args.indexOf("--symbol");
  const assetClassFlagIndex = args.indexOf("--asset-class");
  const symbol =
    symbolFlagIndex >= 0 && args[symbolFlagIndex + 1] ? args[symbolFlagIndex + 1] : "QQQ";
  const assetClass =
    assetClassFlagIndex >= 0 && args[assetClassFlagIndex + 1]
      ? args[assetClassFlagIndex + 1].toLowerCase()
      : "etf";
  return {
    json: args.includes("--json"),
    live: args.includes("--live"),
    symbol: symbol.toUpperCase(),
    assetClass,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.live) {
    process.stdout.write(
      [
        "finance-data-gateway-live-smoke: dry mode (no network fetch).",
        "Pass --live to fetch the public primary, cross-check, official, and issuer sources.",
        "Example: node --import tsx scripts/operator/finance-data-gateway-live-smoke.ts --live --symbol QQQ --json",
        "Crypto example: node --import tsx scripts/operator/finance-data-gateway-live-smoke.ts --live --asset-class crypto --symbol BTCUSDT --json",
        "Boundary: research-only; every source attempt and unavailable adapter is reported.",
      ].join("\n"),
    );
    process.stdout.write("\n");
    return 0;
  }

  let receipt;
  try {
    receipt = await runFinanceRealtimeRefresh({
      request: {
        instrument: options.symbol,
        assetClass: options.assetClass,
        useCase: "live_gateway_smoke_portfolio_macro_risk_research",
        asOf: new Date().toISOString(),
        requireOfficialReference: options.assetClass !== "crypto",
        freshnessMaxMinutes: options.assetClass === "crypto" ? 60 : 60 * 24 * 5,
        crossSourceSkewMaxMinutes: options.assetClass === "crypto" ? 30 : 60 * 24,
      },
      adapters: createFinanceRealtimeSourceRegistry(
        resolveFinanceRealtimeSourceRegistryOptionsFromEnv(),
      ),
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

  if (options.json) {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    const priceField = receipt.snapshot?.normalizedFields.find(
      (field) => field.name === "last_price",
    );
    process.stdout.write(
      [
        `instrument=${receipt.request.instrument}`,
        "live=true source_registry=multi",
        `status=${receipt.status}`,
        `last_price=${priceField?.value ?? "none"}`,
        `sourceTimestamp=${priceField?.sourceTimestamp ?? "none"}`,
        `sourceAttempts=${receipt.sourceAttempts.map((attempt) => `${attempt.adapterId}:${attempt.status}`).join(",") || "none"}`,
        `missingEvidence=${receipt.missingEvidence.join(",") || "none"}`,
      ].join("\n"),
    );
    process.stdout.write("\n");
  }
  return receipt.status === "blocked" &&
    receipt.sourceAttempts.every((attempt) => attempt.status !== "succeeded")
    ? 2
    : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`live_smoke_error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
