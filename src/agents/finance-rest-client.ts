/**
 * REST client for declared finance data connectors.
 *
 * Sits beside `finance-mcp-client.ts`: MCP connectors and REST connectors are two transports of
 * the same declared connector surface, so they get sibling clients rather than one client doing
 * both. Callers pass a connector id, never a URL, so the registry stays the single source of
 * truth for where data comes from.
 */

import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";

export const FINANCE_REST_USER_AGENT = "lcx-agent/1.0 (finance research)";

export type FinanceRestCallInput = Readonly<{
  endpoint: string;
  path?: string;
  params?: Record<string, string | number | boolean>;
  headers?: Readonly<Record<string, string>>;
  proxyUrl?: string;
  timeoutMs?: number;
}>;

export type FinanceRestCallResult = Readonly<{
  url: string;
  status: number;
  body: string;
}>;

/**
 * Resolve a call to a concrete URL.
 *
 * The base always comes from the registry and a `path` carrying a scheme is rejected: accepting a
 * caller-supplied absolute URL would turn this into an open proxy that sidesteps the guard's
 * host checks.
 */
export function buildConnectorRestUrl(
  base: string,
  path?: string,
  params?: Record<string, string | number | boolean>,
): string {
  const url = new URL(base);
  if (path && path.trim()) {
    const trimmed = path.trim();
    if (trimmed.includes("://") || trimmed.startsWith("//")) {
      throw new Error("path must be relative to the declared connector endpoint");
    }
    const basePath = url.pathname.replace(/\/+$/u, "");
    url.pathname = `${basePath}/${trimmed.replace(/^\/+/u, "")}`;
  }
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Read-only by design: research connectors are fetched, never written to. */
export async function callConnectorRest(
  input: FinanceRestCallInput,
): Promise<FinanceRestCallResult> {
  const url = buildConnectorRestUrl(input.endpoint, input.path, input.params);
  const result = await fetchWithSsrFGuard({
    url,
    init: {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": FINANCE_REST_USER_AGENT,
        ...input.headers,
      },
    },
    ...(input.proxyUrl ? { proxyUrl: input.proxyUrl } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
  try {
    return {
      url: result.finalUrl,
      status: result.response.status,
      body: await result.response.text(),
    };
  } finally {
    await result.release();
  }
}
