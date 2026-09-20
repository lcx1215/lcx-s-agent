import type { OpenClawConfig } from "../../config/config.js";
import {
  fetchWithSsrFGuard,
  type GuardedFetchOptions,
  type GuardedFetchResult,
  withStrictGuardedFetchMode,
} from "../../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";

const WEB_TOOLS_TRUSTED_NETWORK_SSRF_POLICY: SsrFPolicy = {
  dangerouslyAllowPrivateNetwork: true,
  allowRfc2544BenchmarkRange: true,
};

/**
 * Resolve the operator-declared egress route for web tools (`tools.web.proxy`).
 *
 * Single source of truth for web_search, web_fetch, and citation-redirect resolution: they all
 * share one declaration so a half-configured deployment cannot silently egress two different ways.
 *
 * Returns `undefined` when unset, which means "connect directly". Ambient HTTP_PROXY/HTTPS_PROXY/
 * ALL_PROXY variables are deliberately never consulted either way, so the same config behaves
 * identically on a laptop behind a VPN and on AWS/Cloudflare. Blank strings are treated as unset.
 */
export function resolveWebToolsProxyUrl(cfg?: OpenClawConfig): string | undefined {
  const raw = cfg?.tools?.web?.proxy;
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

type WebToolGuardedFetchOptions = Omit<
  GuardedFetchOptions,
  "mode" | "proxy" | "dangerouslyAllowEnvProxyWithoutPinnedDns"
> & {
  timeoutSeconds?: number;
};
type WebToolEndpointFetchOptions = Omit<WebToolGuardedFetchOptions, "policy">;

function resolveTimeoutMs(params: {
  timeoutMs?: number;
  timeoutSeconds?: number;
}): number | undefined {
  if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
    return params.timeoutMs;
  }
  if (typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)) {
    return params.timeoutSeconds * 1000;
  }
  return undefined;
}

export async function fetchWithWebToolsNetworkGuard(
  params: WebToolGuardedFetchOptions,
): Promise<GuardedFetchResult> {
  const { timeoutSeconds, ...rest } = params;
  const resolved = {
    ...rest,
    timeoutMs: resolveTimeoutMs({ timeoutMs: rest.timeoutMs, timeoutSeconds }),
  };
  // The egress path is deliberately NOT chosen from ambient HTTP_PROXY/HTTPS_PROXY. The same
  // code has to behave identically on a laptop behind a VPN and on AWS/Cloudflare, and an
  // ambient proxy that dies with the shell would silently break every later request. A caller
  // that genuinely needs a proxy must declare it, not inherit it.
  return fetchWithSsrFGuard(withStrictGuardedFetchMode(resolved));
}

async function withWebToolsNetworkGuard<T>(
  params: WebToolGuardedFetchOptions,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  const { response, finalUrl, release } = await fetchWithWebToolsNetworkGuard(params);
  try {
    return await run({ response, finalUrl });
  } finally {
    await release();
  }
}

/**
 * "Trusted" here means the SSRF policy, not the egress mode: web tool providers are
 * operator-declared endpoints, so private-network addresses are allowed. The egress mode stays
 * strict so that no ambient proxy variable can redirect these requests.
 */
export async function withTrustedWebToolsEndpoint<T>(
  params: WebToolEndpointFetchOptions,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  return await withWebToolsNetworkGuard(
    {
      ...params,
      policy: WEB_TOOLS_TRUSTED_NETWORK_SSRF_POLICY,
    },
    run,
  );
}

export async function withStrictWebToolsEndpoint<T>(
  params: WebToolEndpointFetchOptions,
  run: (result: { response: Response; finalUrl: string }) => Promise<T>,
): Promise<T> {
  return await withWebToolsNetworkGuard(params, run);
}
