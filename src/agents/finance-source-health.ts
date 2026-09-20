import fs from "node:fs/promises";
import path from "node:path";
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
import { financeReceiptsDir, resolveFinanceStateDir } from "./finance-state-dir.js";

export { financeProviderId } from "./finance-source-scheduler.js";
type Observation = {
  asOf: string;
  dispatchedAt: string;
  status: string;
  packetStatus: string;
  receiptPath: string;
};

type HealthReceipt = {
  schemaVersion?: unknown;
  adaptersCalled?: unknown;
  request?: { asOf?: unknown };
  sourceAttempts?: unknown;
  status?: unknown;
};

function latestDispatchTime(attempt: unknown): number | undefined {
  if (
    !attempt ||
    typeof attempt !== "object" ||
    !("apiCalls" in attempt) ||
    !Array.isArray((attempt as { apiCalls?: unknown }).apiCalls)
  ) {
    return undefined;
  }
  const dispatchTimes = (attempt as { apiCalls: unknown[] }).apiCalls.flatMap((call: unknown) => {
    if (!call || typeof call !== "object") {
      return [];
    }
    // `dispatchedAt` is the moment the request left, which is the most faithful "when we saw this".
    // Receipts written before it was recorded still carry `finishedAt`, and discarding them made
    // the entire stored corpus invisible: hundreds of real source calls reported as `unverified`,
    // which reads as "this was never called" when the truth is "it was called and the evidence is
    // old". Falling back to completion time does not weaken the freshness bound — an old receipt
    // still lands past the 24h cutoff as `verification_expired` — it only stops the evidence from
    // vanishing, and `unverified` keeps its meaning: called never, not called long ago.
    const candidate = (call as Record<string, unknown>).dispatchedAt;
    const fallback = (call as Record<string, unknown>).finishedAt;
    for (const value of [candidate, fallback]) {
      if (typeof value !== "string") {
        continue;
      }
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) {
        return [timestamp];
      }
    }
    return [];
  });
  return dispatchTimes.length > 0 ? Math.max(...dispatchTimes) : undefined;
}

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
  const catalogOnlyCredentials: Partial<Record<(typeof FINANCE_CREDENTIAL_KEYS)[number], string>> =
    {
      ALPHA_VANTAGE_API_KEY: "catalog-only",
      COINGECKO_API_KEY: "catalog-only",
      COINCAP_API_KEY: "catalog-only",
      MASSIVE_API_KEY: "catalog-only",
      ALPACA_API_KEY_ID: "catalog-only-id",
      ALPACA_API_SECRET_KEY: "catalog-only-secret",
      FINNHUB_API_KEY: "catalog-only",
      TWELVE_DATA_API_KEY: "catalog-only",
      FRED_API_KEY: "catalog-only",
      FMP_API_KEY: "catalog-only",
    };
  for (const [key, value] of Object.entries(catalogOnlyCredentials)) {
    if (value !== undefined) {
      allEnv[key as keyof NodeJS.ProcessEnv] ||= value;
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
  const financeDir = resolveFinanceStateDir({ env, workspaceDir: options.workspaceDir }).directory;
  const roots = [
    financeReceiptsDir(financeDir),
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
            const dispatchedAtMs = latestDispatchTime(attempt);
            if (dispatchedAtMs === undefined || dispatchedAtMs > inspectionTime) {
              continue;
            }
            const previous = latest.get(attempt.adapterId);
            const previousTime = Date.parse(previous?.dispatchedAt ?? "");
            // Equal timestamps cannot establish recovery; retain the failure conservatively.
            if (
              previousTime > dispatchedAtMs ||
              (previousTime === dispatchedAtMs && previous?.status === "failed")
            ) {
              continue;
            }
            latest.set(attempt.adapterId, {
              asOf,
              dispatchedAt: new Date(dispatchedAtMs).toISOString(),
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
    stateDir: financeDir,
    now: () => inspectionTime,
  }).inspect();
  const routes = declared.map((adapter) => {
    const observation = latest.get(adapter.id);
    const ageMs = observation ? inspectionTime - Date.parse(observation.dispatchedAt) : Infinity;
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
