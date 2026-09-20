import {
  Agent,
  getGlobalDispatcher,
  ProxyAgent,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import type { OpenClawConfig } from "../config/config.js";
import {
  isAmbientEnvProxyDispatcher,
  isDeclaredProxyDispatcher,
} from "../infra/net/egress-dispatcher.js";
import { syncAmbientEgressEnv } from "../infra/net/egress-env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/egress");

/**
 * Resolve the declared egress route for model requests, or `undefined` for a direct connection.
 *
 * The declaration lives in `models.proxy`. A blank value is treated as "not declared" rather than as
 * a third state: unlike the finance sources — where the undeclared default is to follow the ambient
 * proxy and a distinct "direct" value is therefore meaningful — the model path is direct by default,
 * so an empty string and an absent field ask for the same thing.
 */
export function resolveModelsProxyUrl(config?: OpenClawConfig): string | undefined {
  const raw = config?.models?.proxy;
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

let installedDispatcher: Dispatcher | null = null;
let installedProxyUrl: string | null = null;

function readGlobalDispatcher(): unknown {
  try {
    return getGlobalDispatcher();
  } catch {
    return undefined;
  }
}

function installDispatcher(dispatcher: Dispatcher, proxyUrl: string | null): void {
  try {
    setGlobalDispatcher(dispatcher);
  } catch {
    // Ignore if setGlobalDispatcher is unavailable in this runtime.
    return;
  }
  installedDispatcher = dispatcher;
  installedProxyUrl = proxyUrl;
  log.info(
    proxyUrl === null
      ? "model egress: direct (ambient proxy variables ignored)"
      : "model egress: declared proxy",
  );
}

/** Test hook: forget which dispatcher this module installed. */
export function resetModelEgressStateForTests(): void {
  installedDispatcher = null;
  installedProxyUrl = null;
}

/**
 * Stop the host's proxy environment from routing *any* undici-backed request in this process.
 *
 * `ensureModelEgressDispatcher` only runs immediately before a model request, so every plain
 * `fetch` that happens before the first model turn — onboarding probes, `doctor` config checks,
 * provider discovery, a local Ollama lookup — still follows whatever proxy the host exported. On a
 * laptop with a VPN client that is exactly the behaviour the egress requirement forbids, and a
 * local `127.0.0.1` probe routed through a proxy fails outright.
 *
 * This is the startup half of the same rule, and deliberately the *smaller* half:
 *
 * - It only ever replaces an ambient dispatcher, so a declaration made later still wins.
 * - It never touches the environment. Child processes (`pnpm`, installers) keep inheriting the
 *   host's proxy variables, which is what those tools expect. Only the model turn aligns the
 *   environment, and only for dependencies that read nothing else.
 *
 * Safe to call more than once; a respawned CLI re-runs this entry point.
 */
export function ensureStartupEgressDispatcher(): void {
  const current = readGlobalDispatcher();
  if (!isAmbientEnvProxyDispatcher(current)) {
    return;
  }
  installDispatcher(new Agent(), null);
}

/**
 * Make the process-wide undici dispatcher match the declared model egress route.
 *
 * Why the global dispatcher is the only lever: `@mariozechner/pi-ai` hands its official SDK clients
 * (`new Anthropic({...})`, `new OpenAI({...})`) no `fetch` option at all, so every model request
 * inherits `globalThis.fetch` and therefore whatever dispatcher is installed process-wide. pi-ai
 * installs an `EnvHttpProxyAgent` as a side effect of being imported, which lets the host
 * environment — a VPN client, a shell profile, a container image — pick the route. That is exactly
 * the dependency the "same build on a laptop and on AWS/Cloudflare" requirement forbids.
 *
 * The guard is deliberately narrow. It only ever replaces an *ambient* dispatcher:
 *
 * - `models.proxy` set → the declared route wins and is (re)installed.
 * - otherwise, a declared `ProxyAgent` is preserved, because somebody chose it on purpose.
 * - otherwise, a non-ambient agent is preserved, because telegram installs one carrying its IPv6
 *   workaround and overwriting it would silently undo that fix.
 *
 * Measured on Node 22: pi-ai's replacement lands one macrotask tick after the module loads, so this
 * must be called after some real I/O has happened — not in the same tick as the import.
 */
export function ensureModelEgressDispatcher(config?: OpenClawConfig): void {
  const proxyUrl = resolveModelsProxyUrl(config);

  // Some providers never see the dispatcher above: the AWS Bedrock provider inside pi-ai reads
  // proxy variables itself and drives Node's `http` module. Align the environment with the same
  // declaration so those paths cannot diverge from the HTTP ones.
  syncAmbientEgressEnv(proxyUrl);

  const current = readGlobalDispatcher();

  if (proxyUrl !== undefined) {
    if (current === installedDispatcher && installedProxyUrl === proxyUrl) {
      return;
    }
    installDispatcher(new ProxyAgent(proxyUrl), proxyUrl);
    return;
  }

  // Nothing is declared. Drop a proxy route that this module installed on a declaration which no
  // longer exists, so clearing `models.proxy` takes effect instead of leaving a stale route behind.
  if (installedProxyUrl !== null && current === installedDispatcher) {
    installDispatcher(new Agent(), null);
    return;
  }

  if (!isAmbientEnvProxyDispatcher(current)) {
    // Either a declared proxy or a tuned direct agent: both already satisfy the requirement.
    if (isDeclaredProxyDispatcher(current)) {
      log.debug("model egress: keeping the proxy dispatcher declared elsewhere");
    }
    installedDispatcher = null;
    installedProxyUrl = null;
    return;
  }

  installDispatcher(new Agent(), null);
}
