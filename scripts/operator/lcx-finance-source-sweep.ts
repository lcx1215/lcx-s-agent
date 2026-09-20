/**
 * Sweep every registered source and report which ones actually return data.
 *
 * The registry holds on the order of a hundred and seventy routes across two
 * dozen providers, and only a handful have ever been called. Before wiring more
 * sources into a signal, it is worth knowing which ones deliver anything for
 * this instrument at all - otherwise the choice of source is guesswork dressed
 * as design.
 *
 * This asks each adapter what it supports, runs the ones that answer, and
 * records what came back. It reports failures rather than hiding them: a source
 * that is registered but returns nothing is exactly the kind of thing that
 * should be visible, because a coverage claim built on untested routes is not
 * coverage.
 *
 * Nothing is traded and nothing is written to the sample pool. It is a
 * discovery tool.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-source-sweep.ts \
 *     --instrument AAPL [--json] [--report PATH]
 */

import { writeFileSync } from "node:fs";
import { resolveFinanceCredentialEnv } from "../../src/agents/finance-credential-env.js";
import { createFinanceMarketCollectionRegistry } from "../../src/agents/finance-market-collection-registry.js";
import { runFinanceMarketCollectionRefresh } from "../../src/agents/finance-market-collection-registry.js";

const CANDIDATE_COLLECTIONS = [
  "eod_history",
  "company_profile",
  "financial_statements",
  "analyst_estimates",
  "ownership",
  "news",
  "sec_filings",
  "dividends",
  "splits",
  "earnings",
  "earnings_calendar",
  "economic_calendar",
  "quote",
  "macro",
  "fred_series",
  "treasury",
  "transcripts",
  "etf_holdings",
  "insider",
];

type Row = {
  adapterId: string;
  collection: string;
  records: number;
  status: string;
  fields: string[];
  error?: string;
};

function readArg(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const instrument = (readArg(args, "--instrument") ?? "AAPL").toUpperCase();
  const reportPath = readArg(args, "--report");

  const env = resolveFinanceCredentialEnv(process.env) as Record<string, unknown>;
  const key = (name: string) => (typeof env[name] === "string" ? String(env[name]) : "");

  const registry = createFinanceMarketCollectionRegistry({
    fmpApiKey: key("FMP_API_KEY"),
    alphaVantageApiKey: key("ALPHA_VANTAGE_API_KEY"),
    massiveApiKey: key("MASSIVE_API_KEY"),
    finnhubApiKey: key("FINNHUB_API_KEY"),
    twelveDataApiKey: key("TWELVE_DATA_API_KEY"),
    fredApiKey: key("FRED_API_KEY"),
  });
  const adapters = registry.adapters ?? registry;

  const asOf = new Date().toISOString();
  const rows: Row[] = [];
  // Cap the fan-out: a full sweep is hundreds of provider calls, which is both
  // slow and rude to the free tiers.
  const MAX_ATTEMPTS = Number(process.env.LCX_SWEEP_MAX ?? 60);
  let attempts = 0;
  // Cap the fan-out: a full sweep is hundreds of provider calls, which is both
  // slow and rude to the free tiers.

  process.stderr.write("sweeping " + adapters.length + " adapters...\n");

  for (const adapter of adapters) {
    const supports = (adapter as { supports?: (r: unknown) => boolean }).supports;
    if (typeof supports !== "function") {
      continue;
    }
    let matched = 0;
    for (const collection of CANDIDATE_COLLECTIONS) {
      let ok = false;
      try {
        ok = supports.call(adapter, { collection, instrument, assetClass: "us_equity", asOf });
      } catch {
        ok = false;
      }
      if (!ok) {
        continue;
      }
      matched += 1;
      attempts += 1;
      if (attempts > MAX_ATTEMPTS) {
        break;
      }
      try {
        const result = await runFinanceMarketCollectionRefresh({
          request: {
            collection,
            instrument,
            assetClass: "us_equity",
            asOf,
            limit: 5,
            fromDate: new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10),
            toDate: asOf.slice(0, 10),
          } as never,
          adapters: [adapter],
        });
        const records = result.records ?? [];
        const first = records[0] as { data?: Record<string, unknown> } | undefined;
        rows.push({
          adapterId: adapter.id,
          collection,
          records: records.length,
          status: "ok",
          fields: first?.data ? Object.keys(first.data).slice(0, 8) : [],
        });
      } catch (error) {
        rows.push({
          adapterId: adapter.id,
          collection,
          records: 0,
          status: "error",
          fields: [],
          error: String(error).slice(0, 90),
        });
      }
      if (matched >= 3) {
        break;
      }
    }
  }

  const working = rows.filter((row) => row.records > 0);
  const failed = rows.filter((row) => row.records === 0);

  process.stdout.write(
    "=== sources that returned data for " + instrument + " (" + working.length + ") ===\n",
  );
  for (const row of working) {
    process.stdout.write(
      "  " + row.adapterId.padEnd(48) + row.collection.padEnd(22) + "n=" + row.records + "\n",
    );
  }
  process.stdout.write("\n=== registered but returned nothing (" + failed.length + ") ===\n");
  for (const row of failed.slice(0, 20)) {
    process.stdout.write(
      "  " +
        row.adapterId.padEnd(48) +
        row.collection.padEnd(22) +
        (row.error ?? "no records") +
        "\n",
    );
  }
  if (failed.length > 20) {
    process.stdout.write("  ... and " + (failed.length - 20) + " more\n");
  }

  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify({ instrument, asOf, working, failed }, null, 2));
    process.stdout.write("\nreport written to " + reportPath + "\n");
  }
}

await main();
