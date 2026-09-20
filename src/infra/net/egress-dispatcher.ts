/**
 * Classification primitives for the process-wide undici dispatcher.
 *
 * Every `fetch()` call that does not pass an explicit `dispatcher` inherits the global one, so
 * "which dispatcher is installed right now" decides the egress route for the whole process. That
 * makes it a compliance-relevant fact rather than an implementation detail: the same build has to
 * reach the network the same way on a laptop behind a VPN and on AWS/Cloudflare.
 *
 * Two kinds of proxy dispatcher have to be told apart, because they call for opposite handling:
 *
 * - **Declared** (`ProxyAgent`): an operator, a config field or a call site chose this route on
 *   purpose. It must be preserved — silently replacing it would discard a deliberate decision.
 * - **Ambient** (`EnvHttpProxyAgent`): the route is read out of `HTTP_PROXY` / `HTTPS_PROXY` /
 *   `ALL_PROXY` when the agent is constructed, so the *host environment* picks the route. Nothing in
 *   this repository declares it, and `@mariozechner/pi-ai` installs one as a side effect of being
 *   imported. It must never be mistaken for configuration.
 *
 * Keep this the single source of truth: two copies of the same predicate means fixing one of them
 * looks like a fix while the other keeps the old behaviour.
 */

/** Constructor name of a dispatcher, or `undefined` when it cannot be read. */
export function dispatcherConstructorName(dispatcher: unknown): string | undefined {
  const name = (dispatcher as { constructor?: { name?: string } } | undefined)?.constructor?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * True when the dispatcher derives its route from ambient proxy environment variables.
 *
 * Measured on Node 22: `@mariozechner/pi-ai` replaces the global dispatcher with an
 * `EnvHttpProxyAgent` one macrotask tick after the module finishes loading, so any guard that runs
 * after real I/O observes it here.
 */
export function isAmbientEnvProxyDispatcher(dispatcher: unknown): boolean {
  return dispatcherConstructorName(dispatcher) === "EnvHttpProxyAgent";
}

/**
 * True when the dispatcher is a genuinely declared proxy route.
 *
 * `EnvHttpProxyAgent` is excluded on purpose even though its name contains `"ProxyAgent"`: a plain
 * substring test would classify the dependency-installed ambient agent as operator configuration and
 * preserve it, letting the host environment keep picking the egress route.
 */
export function isDeclaredProxyDispatcher(dispatcher: unknown): boolean {
  const name = dispatcherConstructorName(dispatcher);
  if (name === undefined || name === "EnvHttpProxyAgent") {
    return false;
  }
  return name.includes("ProxyAgent");
}
