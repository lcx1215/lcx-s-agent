/**
 * Ambient proxy variables, as seen by the dependencies we cannot configure.
 *
 * Most of this repo routes through an explicit declaration — `fetchWithSsrFGuard({ proxyUrl })`,
 * the telegram/slack fixes, `models.proxy` for the model SDKs. A few dependencies read proxy
 * variables straight off `process.env` and cannot be pointed anywhere else. The one that matters is
 * `pi-ai`'s AWS Bedrock provider, which also bypasses undici entirely:
 *
 * ```js
 * if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.NO_PROXY || … ) {
 *   config.requestHandler = new NodeHttpHandler({ httpAgent: new ProxyAgent(), … });
 * }
 * ```
 *
 * The AWS SDK talks to Node's `http` module, so the process-wide undici dispatcher cannot reach it.
 * The only lever left is the environment those variables are read from.
 *
 * Writing them is not the same offence as reading them: the rule is "ambient variables must not
 * decide the route", and setting them to the declared value — or removing them — is how that rule
 * is enforced against a dependency that understands nothing else.
 */

/** Variables a proxy-aware dependency reads to find its proxy. */
const AMBIENT_PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;

/**
 * Variables that opt hosts out of the proxy.
 *
 * `NO_PROXY` alone is enough to arm Bedrock's ambient branch, so it cannot be left behind when the
 * intent is "no ambient route".
 */
const AMBIENT_NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;

/**
 * Align the ambient proxy environment with the declared model egress route.
 *
 * - Declared: every proxy variable is set to that value and the opt-out list is removed, so a
 *   dependency that only understands the environment takes the declared route with no exceptions.
 * - Undeclared: all of them are removed, so such a dependency connects directly instead of
 *   inheriting a VPN client, a shell profile, or a container image.
 *
 * Idempotent, and deliberately dumb: it never inspects the current values to make a decision.
 */
export function syncAmbientEgressEnv(proxyUrl: string | undefined): void {
  if (proxyUrl) {
    for (const key of AMBIENT_PROXY_KEYS) {
      process.env[key] = proxyUrl;
    }
    for (const key of AMBIENT_NO_PROXY_KEYS) {
      delete process.env[key];
    }
    return;
  }

  for (const key of [...AMBIENT_PROXY_KEYS, ...AMBIENT_NO_PROXY_KEYS]) {
    delete process.env[key];
  }
}
