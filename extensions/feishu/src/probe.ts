import { raceWithTimeoutAndAbort } from "./async.js";
import { createFeishuClient, type FeishuClientCredentials } from "./client.js";
import type { FeishuProbeResult } from "./types.js";

/** Cache probe results to reduce repeated health-check calls.
 * Gateway health checks call probeFeishu() every minute; without caching this
 * burns ~43,200 calls/month, easily exceeding Feishu's free-tier quota.
 * Successful bot info is effectively static, while failures are cached briefly
 * to avoid hammering the API during transient outages. */
const probeCache = new Map<string, { result: FeishuProbeResult; expiresAt: number }>();
const PROBE_SUCCESS_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PROBE_ERROR_TTL_MS = 60 * 1000; // 1 minute
const MAX_PROBE_CACHE_SIZE = 64;
export const FEISHU_PROBE_REQUEST_TIMEOUT_MS = 10_000;
export type ProbeFeishuOptions = {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

export function isFeishuProbeDegraded(result: FeishuProbeResult | null | undefined): boolean {
  return result?.health === "degraded";
}

export function formatFeishuProbeStatusLabel(
  result: FeishuProbeResult | null | undefined,
): string | undefined {
  if (!result) {
    return undefined;
  }
  if (result.ok && !isFeishuProbeDegraded(result)) {
    return `connected as ${result.botName ?? result.botOpenId ?? "bot"}`;
  }
  if (isFeishuProbeDegraded(result)) {
    return `degraded${result.reason ? `:${result.reason}` : ""}`;
  }
  return result.ok ? "connected (degraded status unknown)" : "configured (connection not verified)";
}

type FeishuBotInfoResponse = {
  code: number;
  msg?: string;
  bot?: { bot_name?: string; open_id?: string };
  data?: { bot?: { bot_name?: string; open_id?: string } };
};

function classifyProbeFailure(
  error: string | undefined,
): Pick<FeishuProbeResult, "health" | "reason"> | undefined {
  const normalized = error?.toLowerCase() ?? "";
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("aborted")) {
    return { health: "degraded", reason: "aborted" };
  }
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return { health: "degraded", reason: "timeout" };
  }
  if (
    normalized.includes("enotfound") ||
    normalized.includes("eai_again") ||
    normalized.includes("dns")
  ) {
    return { health: "degraded", reason: "dns" };
  }
  if (
    normalized.includes("econnrefused") ||
    normalized.includes("network error") ||
    normalized.includes("socket hang up") ||
    normalized.includes("certificate") ||
    normalized.includes("unable to verify")
  ) {
    return { health: "degraded", reason: "network" };
  }
  return undefined;
}

function setCachedProbeResult(
  cacheKey: string,
  result: FeishuProbeResult,
  ttlMs: number,
): FeishuProbeResult {
  probeCache.set(cacheKey, { result, expiresAt: Date.now() + ttlMs });
  if (probeCache.size > MAX_PROBE_CACHE_SIZE) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== undefined) {
      probeCache.delete(oldest);
    }
  }
  return result;
}

export async function probeFeishu(
  creds?: FeishuClientCredentials,
  options: ProbeFeishuOptions = {},
): Promise<FeishuProbeResult> {
  if (!creds?.appId || !creds?.appSecret) {
    return {
      ok: false,
      error: "missing credentials (appId, appSecret)",
    };
  }
  if (options.abortSignal?.aborted) {
    return {
      ok: false,
      appId: creds.appId,
      error: "probe aborted",
    };
  }

  const timeoutMs = options.timeoutMs ?? FEISHU_PROBE_REQUEST_TIMEOUT_MS;

  // Return cached result if still valid.
  // Use accountId when available; otherwise include appSecret prefix so two
  // accounts sharing the same appId (e.g. after secret rotation) don't
  // pollute each other's cache entry.
  const cacheKey = creds.accountId ?? `${creds.appId}:${creds.appSecret.slice(0, 8)}`;
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  try {
    const client = createFeishuClient(creds);
    // Use bot/v3/info API to get bot information
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK generic request method
    const responseResult = await raceWithTimeoutAndAbort<FeishuBotInfoResponse>(
      (client as any).request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
        data: {},
        timeout: timeoutMs,
      }) as Promise<FeishuBotInfoResponse>,
      {
        timeoutMs,
        abortSignal: options.abortSignal,
      },
    );

    if (responseResult.status === "aborted") {
      return {
        ok: false,
        appId: creds.appId,
        error: "probe aborted",
        health: "degraded",
        reason: "aborted",
      };
    }
    if (responseResult.status === "timeout") {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          appId: creds.appId,
          error: `probe timed out after ${timeoutMs}ms`,
          health: "degraded",
          reason: "timeout",
        },
        PROBE_ERROR_TTL_MS,
      );
    }

    const response = responseResult.value;
    if (options.abortSignal?.aborted) {
      return {
        ok: false,
        appId: creds.appId,
        error: "probe aborted",
        health: "degraded",
        reason: "aborted",
      };
    }

    if (response.code !== 0) {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          appId: creds.appId,
          error: `API error: ${response.msg || `code ${response.code}`}`,
          reason: "api_error",
        },
        PROBE_ERROR_TTL_MS,
      );
    }

    const bot = response.bot || response.data?.bot;
    const botOpenId = bot?.open_id?.trim();
    const botName = bot?.bot_name?.trim();
    if (!botOpenId) {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: true,
          appId: creds.appId,
          botName,
          health: "degraded",
          reason: "bot_open_id_unavailable",
          error: "bot open_id unavailable",
        },
        PROBE_ERROR_TTL_MS,
      );
    }
    return setCachedProbeResult(
      cacheKey,
      {
        ok: true,
        appId: creds.appId,
        botName,
        botOpenId,
        health: "healthy",
      },
      PROBE_SUCCESS_TTL_MS,
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const classified = classifyProbeFailure(error);
    return setCachedProbeResult(
      cacheKey,
      {
        ok: false,
        appId: creds.appId,
        error,
        ...classified,
      },
      PROBE_ERROR_TTL_MS,
    );
  }
}

/** Clear the probe cache (for testing). */
export function clearProbeCache(): void {
  probeCache.clear();
}
