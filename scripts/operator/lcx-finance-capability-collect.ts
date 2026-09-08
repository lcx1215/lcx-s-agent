import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { extendedFinanceCapabilities } from "../../src/agents/finance-extended-capability-catalog.js";
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
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const selectedIds = option("--adapters")?.split(",");
const recordLimit = Number(option("--limit") ?? "250");
if (!Number.isInteger(recordLimit) || recordLimit < 1 || recordLimit > 250) {
  throw new Error("--limit must be 1..250");
}
const asOf = new Date().toISOString();
const registryOptions = {
  ...resolveFinanceMarketCollectionRegistryOptionsFromEnv(),
  ...(live
    ? {
        captureRawResponse: async (response: {
          adapterId: string;
          sourceUrlOrArtifact: string;
          observedAt: string;
          httpStatus: number;
          body: string;
        }) => {
          const rawPath = path.join(output!, `${response.adapterId}.raw.json`);
          await fs.writeFile(rawPath, JSON.stringify(response, null, 2), {
            mode: 0o600,
            flag: "wx",
          });
          return rawPath;
        },
      }
    : {}),
};
const catalog = extendedFinanceCapabilities(registryOptions).map((c) => ({
  id: c.id,
  provider: c.provider,
  collection: c.collection,
  configured: Boolean(c.key?.trim()),
  documentation: c.documentation,
  requiresExplicitPeriod: !c.sample,
  entitlement: "unverified_until_live_call",
}));
const adapters = createFinanceMarketCollectionRegistry(registryOptions).filter(
  (a) =>
    /^(alpha_vantage_|finnhub_|massive_|coingecko_|twelve_data_|alpaca_|fmp_|fred_macro_series$)/u.test(
      a.id,
    ) &&
    (!selectedIds || selectedIds.includes(a.id)),
);
const defaultTargets = [...buildAllRegisteredFinanceResearchTargets(asOf, 3, [], adapters)];
const requestedSymbol = option("--symbol");
if (requestedSymbol && !selectedIds) {
  throw new Error(
    "--symbol requires --adapters to avoid applying one ticker to unrelated datasets",
  );
}
const targets = defaultTargets.map((t) =>
  requestedSymbol
    ? { ...t, instrument: requestedSymbol, assetClass: option("--asset-class") ?? t.assetClass }
    : t,
);
if (option("--series") && selectedIds) {
  for (const adapter of adapters.filter(
    (a) => !targets.some((t) => t.sourceAdapterIds?.includes(a.id)),
  )) {
    const definition = extendedFinanceCapabilities(registryOptions).find(
      (c) => c.id === adapter.id,
    );
    if (!definition) {
      continue;
    }
    targets.push({
      id: `source-${adapter.id}`,
      sourceAdapterIds: [adapter.id],
      instrument: requestedSymbol ?? "AAPL",
      assetClass: option("--asset-class") ?? "us_equity",
      realtime: false,
      collections: [
        {
          collection: definition.collection,
          seriesId: option("--series"),
          limit: recordLimit,
          freshnessMaxMinutes: 366 * 24 * 60,
        },
      ],
    });
  }
}
const unplannedRequestedAdapterIds =
  selectedIds?.filter((id) => !targets.some((t) => t.sourceAdapterIds?.includes(id))) ?? [];
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
  console.log(
    JSON.stringify({ asOf, live: false, catalog, unplannedRequestedAdapterIds, targets }, null, 2),
  );
} else {
  await fs.mkdir(output!, { recursive: true, mode: 0o700 });
  const summary = [];
  const lastStarted = new Map<string, number>();
  for (const target of targets) {
    for (const collection of target.collections ?? []) {
      const adapterId = target.sourceAdapterIds?.[0] ?? "";
      const provider = adapterId.startsWith("alpha_vantage_")
        ? "alpha_vantage"
        : adapterId.split("_")[0];
      const spacing =
        provider === "alpha_vantage"
          ? 1100
          : provider === "twelve"
            ? 8100
            : provider === "massive"
              ? 12100
              : 0;
      const remaining = spacing - (Date.now() - (lastStarted.get(provider) ?? 0));
      if (remaining > 0) {
        await delay(remaining);
      }
      lastStarted.set(provider, Date.now());
      const receipt = await runFinanceMarketCollectionRefresh({
        request: {
          ...collection,
          instrument: target.instrument,
          assetClass: target.assetClass,
          asOf,
          limit: recordLimit,
          ...(option("--series") ? { seriesId: option("--series") } : {}),
          ...(option("--from") ? { fromDate: option("--from") } : {}),
          ...(option("--to") ? { toDate: option("--to") } : {}),
        },
        adapters: adapters.filter((a) => target.sourceAdapterIds?.includes(a.id)),
        timeoutMs: 15000,
        retry: { attempts: 1 },
      });
      const receiptPath = path.join(output!, `${target.id}.json`);
      await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
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
    JSON.stringify(
      { asOf, boundary: "research_only", catalog, unplannedRequestedAdapterIds, summary },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
