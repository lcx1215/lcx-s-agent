import type { CronService } from "../cron/service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { cronHandlers } from "./server-methods/cron.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

/**
 * Daemon-free implementation of the Gateway's cron RPC surface.
 *
 * `src/agents/tools/cron-tool.ts` talks to cron over the Gateway websocket
 * (`cron.status|list|add|update|remove|run|runs` and `wake`). In a process with
 * no Gateway daemon — the `lcx serve` entry point — those calls would otherwise
 * fail with a connection error, silently disabling agent-side scheduling.
 *
 * Rather than reimplementing the RPC semantics, this bridge reuses the exact
 * production handlers from `server-methods/cron.ts` (including their typebox
 * param validation, pagination, and run-log reads) against an in-process
 * `CronService`. Fidelity is therefore structural, not approximate.
 *
 * Only the cron handlers are reused. Their synthetic context carries exactly the
 * three fields those handlers read — `cron`, `cronStorePath`, and `logGateway` —
 * and nothing else.
 */

export const LOCAL_CRON_METHODS = [
  "wake",
  "cron.status",
  "cron.list",
  "cron.add",
  "cron.update",
  "cron.remove",
  "cron.run",
  "cron.runs",
] as const;

const LOCAL_CRON_METHOD_SET: ReadonlySet<string> = new Set<string>(LOCAL_CRON_METHODS);

export function isLocalCronMethod(method: string): boolean {
  return LOCAL_CRON_METHOD_SET.has(method);
}

/**
 * Signature-compatible with `callGatewayTool` in `src/agents/tools/gateway.ts`,
 * so it can be injected through `CronToolDeps.callGatewayTool`.
 */
export type LocalCronGatewayCaller = <T = Record<string, unknown>>(
  method: string,
  opts: { gatewayUrl?: string; gatewayToken?: string; timeoutMs?: number },
  params?: unknown,
  extra?: { expectFinal?: boolean },
) => Promise<T>;

export function createLocalCronGatewayCaller(params: {
  cron: CronService;
  /** Store path, needed by `cron.runs` to locate the per-job run log. */
  cronStorePath: string;
  logGateway?: SubsystemLogger;
}): LocalCronGatewayCaller {
  // The reused handlers read exactly these three context fields; every other
  // `GatewayRequestContext` member belongs to an unrelated RPC family.
  const context = {
    cron: params.cron,
    cronStorePath: params.cronStorePath,
    logGateway: params.logGateway ?? createSubsystemLogger("gateway"),
  } as unknown as GatewayRequestContext;

  return async function callLocalCron<T>(
    method: string,
    _opts: { gatewayUrl?: string; gatewayToken?: string; timeoutMs?: number },
    params?: unknown,
  ): Promise<T> {
    const handler = cronHandlers[method];
    if (!handler) {
      throw new Error(`local cron bridge does not implement method "${method}"`);
    }

    let ok: boolean | undefined;
    let payload: unknown;
    let error: { message?: string; code?: string } | undefined;
    let responded = false;

    const options = {
      req: { id: `local-cron:${method}`, method, params } as never,
      params: (params ?? {}) as Record<string, unknown>,
      client: null,
      isWebchatConnect: () => false,
      respond: (nextOk: boolean, nextPayload?: unknown, nextError?: unknown) => {
        responded = true;
        ok = nextOk;
        payload = nextPayload;
        error = nextError as { message?: string; code?: string } | undefined;
      },
      context,
    } as unknown as GatewayRequestHandlerOptions;

    await handler(options);

    if (!responded) {
      throw new Error(`local cron handler for "${method}" did not respond`);
    }
    if (ok !== true) {
      const detail = error?.message ?? "unknown error";
      throw new Error(`cron.${method.replace(/^cron\./, "")} failed: ${detail}`);
    }
    // `wake` responds with the (possibly pending) result object; settle it so
    // callers receive a concrete value rather than a promise.
    if (payload && typeof (payload as { then?: unknown }).then === "function") {
      payload = await (payload as Promise<unknown>);
    }
    return payload as T;
  };
}
