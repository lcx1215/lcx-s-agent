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
import { financeResponseCache } from "./finance-response-cache.js";
import { createFinanceQuotaGuard } from "./finance-source-quota.js";
import { financeProviderId, financeQuotaGroupId } from "./finance-source-scheduler.js";

export { financeProviderId } from "./finance-source-scheduler.js";
type Observation = { asOf: string; status: string; packetStatus: string; receiptPath: string };

type HealthReceipt = {
  schemaVersion?: unknown;
  adaptersCalled?: unknown;
  request?: { asOf?: unknown };
  sourceAttempts?: unknown;
  status?: unknown;
};

/** Follow only canonical receipt envelopes, never arbitrary nested JSON or evaluation artifacts. */
function unwrapHealthReceipts(value: unknown, depth = 0): HealthReceipt[] {
  if (depth > 7 || !value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.networkCalled === false || envelope.evaluationMode) {
    return [];
  }
  if (
    envelope.schemaVersion === "lcx_finance_market_collection_v1" ||
    envelope.schemaVersion === "lcx_finance_realtime_refresh_v1"
  ) {
    return [envelope as HealthReceipt];
  }
  if (envelope.schemaVersion === "lcx_finance_research_run_v1") {
    return unwrapHealthReceipts(envelope.batch, depth + 1);
  }
  if (envelope.schemaVersion === "lcx_finance_research_batch_v1" && Array.isArray(envelope.jobs)) {
    return envelope.jobs
      .slice(0, 256)
      .flatMap((job: unknown) =>
        job && typeof job === "object" && "receipt" in job
          ? unwrapHealthReceipts(job.receipt, depth + 1)
          : [],
      );
  }
  return unwrapHealthReceipts(envelope.details ?? envelope.result, depth + 1);
}

/** Presence and last observed calls are separate; no network probes or uptime promises. */
export async function inspectFinanceSourceHealth(options: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  asOf?: string;
}) {
  const asOf = options.asOf ?? new Date().toISOString();
  const inspectionTime = Date.parse(asOf);
  if (!Number.isFinite(inspectionTime)) {
    throw new Error("source health asOf must be an ISO timestamp");
  }
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
    path.join(options.workspaceDir, "memory", "finance-data-gateway", "collections"),
    path.join(options.workspaceDir, "memory", "finance-data-gateway", "realtime"),
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
        for (const receipt of unwrapHealthReceipts(parsed)) {
          const asOf = receipt.request?.asOf;
          if (
            receipt.adaptersCalled !== true ||
            !Array.isArray(receipt.sourceAttempts) ||
            typeof receipt.status !== "string" ||
            typeof asOf !== "string" ||
            !Number.isFinite(Date.parse(asOf)) ||
            Date.parse(asOf) > inspectionTime
          ) {
            continue;
          }
          for (const attempt of receipt.sourceAttempts) {
            if (
              !attempt ||
              typeof attempt !== "object" ||
              typeof attempt.adapterId !== "string" ||
              !["succeeded", "failed"].includes(attempt.status)
            ) {
              continue;
            }
            if (
              Array.isArray(attempt.apiCalls) &&
              !attempt.apiCalls.some(
                (call: unknown) =>
                  call &&
                  typeof call === "object" &&
                  "dispatchedAt" in call &&
                  typeof call.dispatchedAt === "string" &&
                  Number.isFinite(Date.parse(call.dispatchedAt)),
              )
            ) {
              continue;
            }
            const previous = latest.get(attempt.adapterId);
            const previousTime = Date.parse(previous?.asOf ?? "");
            // Equal timestamps cannot establish recovery; retain the failure conservatively.
            if (
              previousTime > Date.parse(asOf) ||
              (previousTime === Date.parse(asOf) && previous?.status === "failed")
            ) {
              continue;
            }
            latest.set(attempt.adapterId, {
              asOf,
              status: attempt.status,
              packetStatus: receipt.status,
              receiptPath: file,
            });
          }
        }
      } catch {
        /* A partial or unrelated artifact is not source-health evidence. */
      }
    }
  }
  for (const root of roots) {
    await scan(root, 1);
  }
  const quotas = await createFinanceQuotaGuard({
    stateDir: resolveStateDir(env),
    now: () => inspectionTime,
  }).inspect();
  const routes = declared.map((adapter) => {
    const observation = latest.get(adapter.id);
    const ageMs = observation ? inspectionTime - Date.parse(observation.asOf) : Infinity;
    return {
      id: adapter.id,
      provider: financeProviderId(adapter.id),
      configured: configured.has(adapter.id),
      quotaGroups: quotas
        .filter((quota) => quota.id === financeQuotaGroupId(adapter.id))
        .map((quota) => ({
          id: quota.id,
          state: quota.state,
          nextAllowedAt: "nextAllowedAt" in quota ? quota.nextAllowedAt : undefined,
        })),
      callState: !configured.has(adapter.id)
        ? "not_configured_or_disabled"
        : !observation
          ? "unverified"
          : ageMs > 24 * 3600000
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
    quotas,
    responseReuse: financeResponseCache.inspect(),
    boundary: "inventory_and_recent_call_evidence_not_continuous_uptime",
    providerCount: new Set(routes.map((r) => r.provider)).size,
    routeCount: routes.length,
    configuredRouteCount: routes.filter((r) => r.configured).length,
    recentSuccessCount: routes.filter((r) => r.callState === "recent_success").length,
    routes,
  };
}
