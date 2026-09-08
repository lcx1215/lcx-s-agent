import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { FINANCE_CREDENTIAL_KEYS, resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import {
  createFinanceMarketCollectionRegistry,
  resolveFinanceMarketCollectionRegistryOptionsFromEnv,
} from "./finance-market-collection-registry.js";
import {
  createFinanceRealtimeSourceRegistry,
  resolveFinanceRealtimeSourceRegistryOptionsFromEnv,
} from "./finance-realtime-source-registry.js";

export function financeProviderId(id: string): string {
  if (id.startsWith("alpha_vantage_")) {
    return "alpha_vantage";
  }
  if (id.startsWith("twelve_data_")) {
    return "twelve_data";
  }
  if (id.startsWith("google_news_")) {
    return "google_news";
  }
  return id.split("_")[0];
}
type Observation = { asOf: string; status: string; packetStatus: string; receiptPath: string };

/** Presence and last observed calls are separate; no network probes or uptime promises. */
export async function inspectFinanceSourceHealth(options: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  asOf?: string;
}) {
  const env = resolveFinanceCredentialEnv(options.env ?? process.env);
  const allEnv = { ...env };
  for (const key of FINANCE_CREDENTIAL_KEYS) {
    if (key.endsWith("KEY") || key.endsWith("KEY_ID")) {
      allEnv[key] ||= "catalog-only";
    }
  }
  allEnv.LCX_ENABLE_YAHOO_PUBLIC_SOURCE = "1";
  allEnv.LCX_ENABLE_YAHOO_PUBLIC_SOURCES = "1";
  const registry = (values: NodeJS.ProcessEnv) => [
    ...createFinanceRealtimeSourceRegistry(
      resolveFinanceRealtimeSourceRegistryOptionsFromEnv(values),
    ),
    ...createFinanceMarketCollectionRegistry(
      resolveFinanceMarketCollectionRegistryOptionsFromEnv(values),
    ),
  ];
  const configured = new Set(registry(env).map((a) => a.id));
  const declared = registry(allEnv);
  const latest = new Map<string, Observation>();
  const roots = [
    path.join(resolveStateDir(env), "finance-caseflow", "receipts"),
    path.join(options.workspaceDir, "memory", "research-data-autopilot"),
  ];
  async function scan(dir: string, depth: number) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth > 0) {
        await scan(file, depth - 1);
        continue;
      }
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".json") ||
        /\.(raw|reparsed)\.json$/u.test(entry.name)
      ) {
        continue;
      }
      try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8"));
        if (parsed.networkCalled === false || parsed.evaluationMode) {
          continue;
        }
        const receipt = parsed.result?.sourceAttempts ? parsed.result : parsed;
        const asOf = receipt.request?.asOf;
        if (
          !["lcx_finance_market_collection_v1", "lcx_finance_realtime_refresh_v1"].includes(
            receipt.schemaVersion,
          ) ||
          receipt.adaptersCalled !== true ||
          !Array.isArray(receipt.sourceAttempts) ||
          typeof asOf !== "string" ||
          !Number.isFinite(Date.parse(asOf))
        ) {
          continue;
        }
        for (const attempt of receipt.sourceAttempts) {
          if (
            typeof attempt.adapterId !== "string" ||
            !["succeeded", "failed"].includes(attempt.status)
          ) {
            continue;
          }
          if (Date.parse(latest.get(attempt.adapterId)?.asOf ?? "") >= Date.parse(asOf)) {
            continue;
          }
          latest.set(attempt.adapterId, {
            asOf,
            status: attempt.status,
            packetStatus: receipt.status,
            receiptPath: file,
          });
        }
      } catch {
        /* A partial or unrelated artifact is not source-health evidence. */
      }
    }
  }
  for (const root of roots) {
    await scan(root, 1);
  }
  const asOf = options.asOf ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(asOf))) {
    throw new Error("source health asOf must be an ISO timestamp");
  }
  const routes = declared.map((adapter) => {
    const observation = latest.get(adapter.id);
    const ageMs = observation ? Date.parse(asOf) - Date.parse(observation.asOf) : Infinity;
    return {
      id: adapter.id,
      provider: financeProviderId(adapter.id),
      configured: configured.has(adapter.id),
      callState: !configured.has(adapter.id)
        ? "not_configured_or_disabled"
        : !observation
          ? "unverified"
          : ageMs < 0 || ageMs > 24 * 3600000
            ? "verification_expired"
            : observation.status === "succeeded"
              ? "recent_success"
              : "recent_failure",
      lastObservation: observation,
    };
  });
  return {
    asOf,
    noNetworkCalled: true,
    boundary: "inventory_and_recent_call_evidence_not_continuous_uptime",
    providerCount: new Set(routes.map((r) => r.provider)).size,
    routeCount: routes.length,
    configuredRouteCount: routes.filter((r) => r.configured).length,
    recentSuccessCount: routes.filter((r) => r.callState === "recent_success").length,
    routes,
  };
}
