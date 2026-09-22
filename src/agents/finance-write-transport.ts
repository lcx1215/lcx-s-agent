/**
 * Write-capable finance transport for actions that are not reads.
 *
 * Why this exists instead of reusing `resolveFinanceFetch`:
 *
 *   resolveFinanceFetch = governApiFetch(
 *     financeResponseCache.wrap(governFinanceQuota(createFinanceNativeFetch())))
 *
 * That chain is built for reads: it caches responses and it drops `method` and
 * `body` (undici then defaults to GET). Measured consequence — an order POST sent
 * through it came back as a 200 with no order id, because it had actually been
 * issued as `GET /v2/orders` and returned the order *list*. Putting writes on
 * that path would also mean caching an order response, so a repeated placement
 * could be served from cache.
 *
 * This module therefore reuses the **egress decision** (`decideFinanceProxy`,
 * the same three-state ambient/direct/explicit rule the read path uses) while
 * skipping the response cache and the read-oriented quota governor. Egress stays
 * a single decision point; only the caching differs, which is the whole point.
 */

import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import {
  ALPACA_FINANCE_HTTP_BODY_MAX_BYTES,
  readBoundedFinanceResponseText,
} from "./finance-http-body.js";
import { decideFinanceProxy } from "./finance-live-market-source.js";

export type FinanceWriteRequest = Readonly<{
  url: string;
  headers: Record<string, string>;
  body: string;
  method?: "POST" | "DELETE";
  signal?: AbortSignal;
}>;

export type FinanceWriteResponse = Readonly<{
  status: number;
  body: string;
}>;

export type FinanceWriteTransport = (request: FinanceWriteRequest) => Promise<FinanceWriteResponse>;

export type FinanceUncachedFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; body: string }>;

/**
 * Uncached read, for polling mutable server-side state such as an order.
 *
 * `resolveFinanceFetch` caches responses, which is right for market data and
 * wrong for "has this order filled yet": a cached submit-time status would be
 * replayed forever and the fill would never be observed. This uses the same
 * egress decision and skips only the cache.
 */
export function createFinanceUncachedFetch(
  options: { directory?: string } = {},
): FinanceUncachedFetch {
  let agent: Agent | EnvHttpProxyAgent | undefined;
  let agentKey: string | undefined;

  const agentFor = (declared: string | undefined) => {
    const decision = decideFinanceProxy(declared);
    const key =
      decision.kind === "direct"
        ? " direct"
        : decision.kind === "ambient"
          ? " ambient"
          : decision.proxy;
    if (agent && key === agentKey) {
      return agent;
    }
    const previous = agent;
    agent =
      decision.kind === "direct"
        ? new Agent({ connectTimeout: 30_000 })
        : new EnvHttpProxyAgent({
            ...(decision.kind === "explicit"
              ? { httpProxy: decision.proxy, httpsProxy: decision.proxy }
              : {}),
            connectTimeout: 30_000,
            requestTls: { timeout: 30_000 },
          });
    agentKey = key;
    void previous?.close().catch(() => undefined);
    return agent;
  };

  return async (url, init) => {
    const env = resolveFinanceCredentialEnv({
      ...process.env,
      ...(options.directory ? { LCX_FINANCE_STATE_DIR: options.directory } : {}),
    });
    const raw = (env as { LCX_FINANCE_HTTP_PROXY?: unknown }).LCX_FINANCE_HTTP_PROXY;
    const response = await undiciFetch(url, {
      dispatcher: agentFor(typeof raw === "string" ? raw : undefined),
      method: "GET",
      headers: init.headers,
      ...(init.signal ? { signal: init.signal } : {}),
    });
    return {
      status: response.status,
      body: await readBoundedFinanceResponseText(response, {
        maxBytes: ALPACA_FINANCE_HTTP_BODY_MAX_BYTES,
        label: "finance uncached GET",
      }),
    };
  };
}

/**
 * Build the single write transport. One agent per egress decision, matching how
 * the read path caches its dispatcher.
 */
export function createFinanceWriteTransport(
  options: { directory?: string } = {},
): FinanceWriteTransport {
  let agent: Agent | EnvHttpProxyAgent | undefined;
  let agentKey: string | undefined;

  const agentFor = (declared: string | undefined) => {
    const decision = decideFinanceProxy(declared);
    const key =
      decision.kind === "direct"
        ? "\u0000direct"
        : decision.kind === "ambient"
          ? "\u0000ambient"
          : decision.proxy;
    if (agent && key === agentKey) {
      return agent;
    }
    const previous = agent;
    agent =
      decision.kind === "direct"
        ? new Agent({ connectTimeout: 30_000 })
        : new EnvHttpProxyAgent({
            ...(decision.kind === "explicit"
              ? { httpProxy: decision.proxy, httpsProxy: decision.proxy }
              : {}),
            connectTimeout: 30_000,
            requestTls: { timeout: 30_000 },
          });
    agentKey = key;
    void previous?.close().catch(() => undefined);
    return agent;
  };

  return async (request) => {
    const env = resolveFinanceCredentialEnv({
      ...process.env,
      ...(options.directory ? { LCX_FINANCE_STATE_DIR: options.directory } : {}),
    });
    const declared =
      typeof (env as { LCX_FINANCE_HTTP_PROXY?: unknown }).LCX_FINANCE_HTTP_PROXY === "string"
        ? (env as { LCX_FINANCE_HTTP_PROXY: string }).LCX_FINANCE_HTTP_PROXY
        : undefined;
    const response = await undiciFetch(request.url, {
      dispatcher: agentFor(declared),
      method: request.method ?? "POST",
      headers: request.headers,
      ...(request.method === "DELETE" ? {} : { body: request.body }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return {
      status: response.status,
      body: await readBoundedFinanceResponseText(response, {
        maxBytes: ALPACA_FINANCE_HTTP_BODY_MAX_BYTES,
        label: "finance write",
      }),
    };
  };
}
