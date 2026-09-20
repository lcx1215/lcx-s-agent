import { withStrictWebToolsEndpoint } from "./web-guarded-fetch.js";

const REDIRECT_TIMEOUT_MS = 5000;

/**
 * Resolve a citation redirect URL to its final destination using a HEAD request.
 * Returns the original URL if resolution fails or times out.
 *
 * `proxyUrl` is the operator-declared egress route (`tools.web.proxy`); when omitted the request
 * goes direct. Ambient proxy variables are never consulted either way.
 */
export async function resolveCitationRedirectUrl(url: string, proxyUrl?: string): Promise<string> {
  try {
    return await withStrictWebToolsEndpoint(
      {
        url,
        init: { method: "HEAD" },
        timeoutMs: REDIRECT_TIMEOUT_MS,
        proxyUrl,
      },
      async ({ finalUrl }) => finalUrl || url,
    );
  } catch {
    return url;
  }
}
