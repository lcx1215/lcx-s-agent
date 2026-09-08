import fs from "node:fs/promises";
import path from "node:path";
import {
  createFinanceMarketCollectionRegistry,
  resolveFinanceMarketCollectionRegistryOptionsFromEnv,
  runFinanceMarketCollectionRefresh,
} from "../../src/agents/finance-market-collection-registry.js";
import { buildAllRegisteredFinanceResearchTargets } from "../../src/agents/finance-research-runner.js";

const args = process.argv.slice(2);
const live = args.includes("--live");
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
if (live && !output) {
  throw new Error("--live requires --output <directory> to preserve evidence");
}
const asOf = new Date().toISOString();
const adapters = createFinanceMarketCollectionRegistry(
  resolveFinanceMarketCollectionRegistryOptionsFromEnv(),
).filter((a) => /^(alpha_vantage_|finnhub_|massive_|coingecko_|fred_macro_series$)/u.test(a.id));
const targets = [...buildAllRegisteredFinanceResearchTargets(asOf, 3, [], adapters)];
const fred = targets.find((t) => t.id === "source-fred_macro_series");
if (fred) {
  for (const seriesId of ["GDP", "UNRATE", "CPIAUCSL", "DGS10"]) {
    targets.push({
      ...fred,
      id: `source-fred-${seriesId}`,
      instrument: seriesId,
      collections: [
        { collection: "macro_series", seriesId, limit: 24, freshnessMaxMinutes: 366 * 24 * 60 },
      ],
    });
  }
}
if (!live) {
  console.log(JSON.stringify({ asOf, live: false, targets }, null, 2));
} else {
  await fs.mkdir(output!, { recursive: true, mode: 0o700 });
  const summary = [];
  for (const target of targets) {
    for (const collection of target.collections ?? []) {
      const receipt = await runFinanceMarketCollectionRefresh({
        request: {
          ...collection,
          instrument: target.instrument,
          assetClass: target.assetClass,
          asOf,
          limit: collection.collection === "eod_history" ? 90 : 24,
        },
        adapters: adapters.filter((a) => target.sourceAdapterIds?.includes(a.id)),
        timeoutMs: 15000,
        retry: { attempts: 1 },
      });
      const receiptPath = path.join(output!, `${target.id}.json`);
      await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
      const entry = {
        id: target.id,
        status: receipt.status,
        records: receipt.records.length,
        receiptPath,
      };
      summary.push(entry);
      console.log(JSON.stringify(entry));
    }
  }
  await fs.writeFile(
    path.join(output!, "manifest.json"),
    JSON.stringify({ asOf, boundary: "research_only", summary }, null, 2),
    { mode: 0o600 },
  );
}
